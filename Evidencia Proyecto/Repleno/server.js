import 'dotenv/config';
import express from 'express';
import pkg from 'transbank-sdk';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync } from 'fs';

// --- FIREBASE ADMIN ---
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// --- IMPORTAR GEMINI ---
import { GoogleGenerativeAI } from "@google/generative-ai";

const { WebpayPlus, IntegrationCommerceCodes, IntegrationApiKeys, Environment, Options } = pkg;

// --- CONFIGURACIÓN DE RUTAS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 1. INICIALIZACIÓN DE FIREBASE ---
let db = null;
let adminAuth = null;
let isFirebaseReady = false;

function initFirebase() {
    try {
        let serviceAccount;
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            console.log("✅ [Firebase] Credenciales cargadas desde Variable de Entorno.");
        } else {
            const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
            if (existsSync(serviceAccountPath)) {
                serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
                console.log("✅ [Firebase] Credenciales cargadas desde 'serviceAccountKey.json'.");
            } else {
                console.warn("⚠️ [Firebase] ADVERTENCIA: No se encontró 'serviceAccountKey.json'.");
                return;
            }
        }

        if (getApps().length === 0) {
            initializeApp({ credential: cert(serviceAccount) });
        }
        
        db = getFirestore();
        adminAuth = getAuth();
        isFirebaseReady = true;
        console.log("🔥 [Firebase] Admin SDK: Conectado.");

    } catch (error) {
        console.error("❌ [Firebase] Error Fatal:", error.message);
    }
}

initFirebase();

// --- 2. CONFIGURACIÓN GEMINI ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "NO_KEY"); 
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// --- 3. CONFIGURACIÓN SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// --- 4. TRANSBANK SETUP ---
const txOptions = new Options(
    IntegrationCommerceCodes.WEBPAY_PLUS, 
    IntegrationApiKeys.WEBPAY, 
    Environment.Integration
);

const TX_FILE = path.join(__dirname, 'transactions_temp.json');

// --- HELPERS ---
function guardarTransaccion(sessionId, data) {
    try {
        let dbCache = {};
        if (existsSync(TX_FILE)) {
            const content = readFileSync(TX_FILE, 'utf8');
            if (content.trim()) dbCache = JSON.parse(content);
        }
        dbCache[sessionId] = { ...data, timestamp: Date.now() };
        writeFileSync(TX_FILE, JSON.stringify(dbCache, null, 2));
    } catch (e) { console.error(e); }
}

function obtenerYBorrarTransaccion(sessionId) {
    try {
        if (!existsSync(TX_FILE)) return {};
        const content = readFileSync(TX_FILE, 'utf8');
        if (!content.trim()) return {};
        const dbCache = JSON.parse(content);
        const data = dbCache[sessionId];
        if (data) {
            delete dbCache[sessionId];
            const now = Date.now();
            Object.keys(dbCache).forEach(k => {
                if (dbCache[k].timestamp && (now - dbCache[k].timestamp > 86400000)) delete dbCache[k];
            });
            writeFileSync(TX_FILE, JSON.stringify(dbCache, null, 2));
            return data;
        }
    } catch (e) { console.error(e); }
    return {};
}

async function deleteCollection(dbRef, collectionPath, batchSize) {
    if (!dbRef) return;
    const collectionRef = dbRef.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);
    return new Promise((resolve, reject) => deleteQueryBatch(dbRef, query, resolve).catch(reject));
}

async function deleteQueryBatch(dbRef, query, resolve) {
    const snapshot = await query.get();
    if (snapshot.size === 0) { resolve(); return; }
    const batch = dbRef.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    process.nextTick(() => deleteQueryBatch(dbRef, query, resolve));
}

const requireDB = (req, res, next) => {
    if (!isFirebaseReady || !db) return res.status(503).json({ error: 'DB no disponible' });
    next();
};

// Limpieza automática
setInterval(async () => {
    if (!isFirebaseReady) return;
    const now = new Date().toISOString();
    try {
        const snapshot = await db.collection('users').where('deletionScheduledAt', '<=', now).get();
        if (!snapshot.empty) {
            for (const doc of snapshot.docs) {
                const uid = doc.id;
                try {
                    await adminAuth.deleteUser(uid).catch(() => {});
                    await deleteCollection(db, `business_data/${uid}/transactions`, 500);
                    await db.collection('business_data').doc(uid).delete();
                    await db.collection('users').doc(uid).delete();
                    console.log(`✅ Usuario ${uid} eliminado.`);
                } catch (err) { console.error(`❌ Error borrando ${uid}:`, err.message); }
            }
        }
    } catch (error) { console.error("Error limpieza:", error.message); }
}, 3600000); 

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function generateContentWithRetry(prompt) {
    let retries = 0;
    while (true) {
        try { return await model.generateContent(prompt); } 
        catch (error) {
            if (retries >= 3) throw error;
            await delay(1000 * (retries + 1));
            retries++;
        }
    }
}

// ================= ENDPOINTS =================

app.delete('/api/admin/users/:uid', requireDB, async (req, res) => {
    try {
        const uid = req.params.uid;
        try { await adminAuth.deleteUser(uid); } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
        await deleteCollection(db, `business_data/${uid}/transactions`, 500);
        await db.collection('business_data').doc(uid).delete();
        await db.collection('users').doc(uid).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// CONSULTORÍA IA (PROMPT ESTRICTO)
app.post('/api/consultar-ia', requireDB, async (req, res) => {
    try {
        if (!GEMINI_API_KEY) return res.status(500).json({ error: "Falta API Key" });
        const userId = req.headers['user-id'];
        if (!userId) return res.status(401).json({ error: 'No autorizado' });

        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists || userDoc.data().plan !== 'Plan Premium') return res.status(403).json({ html: `<div>Solo Premium</div>` });

        const { resumen } = req.body;
        if (!resumen) return res.status(400).json({ error: 'Faltan datos' });

        const prompt = `
            Eres un Gerente de Logística Experto. Analiza los datos REALES proporcionados.
            NO inventes datos. Si falta información, indícalo.
            
            DATOS: ${JSON.stringify(resumen)}

            Tu respuesta debe ser un HTML (sin markdown) usando estas clases Tailwind. Estructura:
            
            <div class="space-y-6 font-inter text-slate-700">
                <!-- Header -->
                <div class="bg-gradient-to-r from-indigo-500 to-purple-600 rounded-2xl p-6 text-white shadow-lg">
                    <h2 class="text-2xl font-bold">📊 Análisis Estratégico</h2>
                    <p class="opacity-90 mt-1">Basado estrictamente en tus datos actuales.</p>
                </div>

                <!-- Análisis Producto Estrella -->
                <div class="bg-white p-5 rounded-2xl border border-indigo-100 shadow-sm">
                    <h3 class="font-bold text-indigo-700 mb-2 flex items-center gap-2">🏆 Producto Estrella: [Nombre Real]</h3>
                    <ul class="text-sm space-y-2">
                        <li>📦 <b>Ventas Totales:</b> [Cantidad Real] unidades.</li>
                        <li>📅 <b>Día de Mayor Venta:</b> [Día calculado de los datos, ej: Viernes].</li>
                        <li>💰 <b>Ingresos Generados:</b> [Calcula: Cantidad * Precio. Si no hay precio, di "No disponible"].</li>
                        <li>📈 <b>Por qué es estrella:</b> [Breve razón basada en volumen comparado con otros].</li>
                    </ul>
                </div>

                <!-- Alerta de Stock (CRÍTICO) -->
                <div class="bg-white p-5 rounded-2xl border border-red-100 shadow-sm">
                    <h3 class="font-bold text-red-600 mb-2 flex items-center gap-2">🚨 Alerta de Stock</h3>
                    <!-- Si lowStockCount > 0: -->
                    <p class="text-sm mb-2">Tienes <b>[lowStockCount]</b> productos con stock crítico:</p>
                    <ul class="list-disc list-inside text-xs text-slate-600 mb-3">
                        <li>[Nombre Producto Bajo Stock] (Quedan: [Cantidad])</li>
                        <!-- Listar máximo 3 -->
                    </ul>
                    <!-- Si lowStockCount == 0: -->
                    <p class="text-sm text-green-600 font-medium">✅ Tu inventario está saludable. No hay alertas críticas.</p>
                </div>

                <!-- Plan de Reposición (Lógica Pura) -->
                <div class="bg-blue-50 p-5 rounded-2xl border border-blue-100">
                    <h3 class="font-bold text-blue-800 mb-2">🚚 Plan de Reabastecimiento</h3>
                    <p class="text-sm text-slate-700 leading-relaxed">
                        Para tu producto estrella, el pico de demanda es el <b>[Día Peak]</b>.
                        Te sugiero comprar el <b>[Día Peak - 3 días]</b> para evitar quiebres.
                        <br><br>
                        <b>Compra Sugerida:</b> [Venta Promedio Semanal del producto] unidades.
                        <br>
                        <span class="text-xs text-slate-500">Evita el sobre-stock: No superes las [Venta Promedio * 2] unidades si no hay promociones.</span>
                    </p>
                </div>
            </div>
        `;

        const result = await generateContentWithRetry(prompt);
        let cleanHtml = result.response.text().replace(/```html/g, '').replace(/```/g, '').trim();
        res.json({ html: cleanHtml });

    } catch (error) {
        if (error.message.includes('403')) return res.status(403).json({ error: 'Llave de IA revocada.' });
        res.status(status).json({ error: 'IA ocupada.' });
    }
});

app.post('/crear-transaccion', async (req, res) => {
  try {
    if (!isFirebaseReady) return res.status(503).json({ error: 'Mantenimiento DB' });
    const { monto, plan, userId } = req.body;
    if (!monto || !plan || !userId) return res.status(400).json({ error: 'Datos incompletos' });
    const buyOrder = 'ORD-' + Math.floor(Math.random() * 100000000);
    const sessionId = 'SES-' + Date.now();
    const returnUrl = `http://localhost:${PORT}/retorno`;
    guardarTransaccion(sessionId, { plan, monto, userId });
    const tx = new WebpayPlus.Transaction(txOptions);
    const response = await tx.create(buyOrder, sessionId, monto, returnUrl);
    res.json({ url: response.url, token: response.token });
  } catch (error) { res.status(500).json({ error: 'Error Webpay' }); }
});

app.get('/retorno', async (req, res) => {
  try {
    const { token_ws, TBK_TOKEN } = req.query;
    if (TBK_TOKEN && !token_ws) return res.redirect(`/retorno.html?status=cancelled`);
    if (token_ws) {
      const tx = new WebpayPlus.Transaction(txOptions);
      const result = await tx.commit(token_ws);
      const sessionData = obtenerYBorrarTransaccion(result.session_id);
      if (result.status === 'AUTHORIZED' && result.response_code === 0 && sessionData.userId) {
        if (isFirebaseReady) await db.collection('users').doc(sessionData.userId).update({ plan: sessionData.plan, planStartDate: new Date().toISOString(), subscriptionStatus: 'active' });
        const params = new URLSearchParams({ status: 'success', amount: result.amount, plan: sessionData.plan, card: result.card_detail?.card_number || "XXXX", date: result.transaction_date || new Date().toISOString() });
        return res.redirect(`/retorno.html?${params.toString()}`);
      }
      return res.redirect(`/retorno.html?status=rejected`);
    }
    res.redirect('/retorno.html?status=invalid');
  } catch (error) { res.redirect('/retorno.html?status=error'); }
});

app.listen(PORT, () => { console.log(`🚀 SERVIDOR ACTIVO: http://localhost:${PORT}`); });