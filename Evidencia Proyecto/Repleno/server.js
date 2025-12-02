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

// --- 1. INICIALIZACIÓN DE FIREBASE (Modo Seguro) ---
let db = null;
let adminAuth = null;
let isFirebaseReady = false;

function initFirebase() {
    try {
        let serviceAccount;
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            console.log("✅ Credenciales Firebase: Variable de Entorno.");
        } else {
            const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
            if (existsSync(serviceAccountPath)) {
                serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
                console.log("✅ Credenciales Firebase: Archivo Local.");
            } else {
                console.warn("⚠️ ADVERTENCIA: No se encontró configuración de Firebase.");
                return;
            }
        }

        if (getApps().length === 0) {
            initializeApp({ credential: cert(serviceAccount) });
        }
        
        db = getFirestore();
        adminAuth = getAuth();
        isFirebaseReady = true;
        console.log("🔥 Firebase Admin SDK: Conectado.");

    } catch (error) {
        console.error("❌ Error Inicializando Firebase:", error.message);
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
    } catch (e) {
        console.error("Error guardando tx:", e.message);
    }
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
    } catch (e) { console.error("Error leyendo tx:", e.message); }
    return {};
}

// Borrado recursivo por lotes
async function deleteCollection(dbRef, collectionPath, batchSize) {
    if (!dbRef) return;
    const collectionRef = dbRef.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);

    return new Promise((resolve, reject) => {
        deleteQueryBatch(dbRef, query, resolve).catch(reject);
    });
}

async function deleteQueryBatch(dbRef, query, resolve) {
    const snapshot = await query.get();
    if (snapshot.size === 0) { resolve(); return; }
    const batch = dbRef.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    process.nextTick(() => deleteQueryBatch(dbRef, query, resolve));
}

// --- MIDDLEWARE DB ---
const requireDB = (req, res, next) => {
    if (!isFirebaseReady || !db) return res.status(503).json({ error: 'DB no disponible' });
    next();
};

// --- HELPER IA ---
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

// 1. ELIMINACIÓN INMEDIATA (Admin)
app.delete('/api/admin/users/:uid', requireDB, async (req, res) => {
    try {
        const uid = req.params.uid;
        await adminAuth.deleteUser(uid).catch(() => {});
        await deleteCollection(db, `business_data/${uid}/transactions`, 500);
        await db.collection('business_data').doc(uid).delete();
        await db.collection('users').doc(uid).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. CONSULTORÍA IA MEJORADA (Prompt Estético y Visual)
app.post('/api/consultar-ia', requireDB, async (req, res) => {
    try {
        if (!GEMINI_API_KEY) return res.status(500).json({ error: "Falta API Key" });
        
        const userId = req.headers['user-id'];
        if (!userId) return res.status(401).json({ error: 'No autorizado' });

        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists || userDoc.data().plan !== 'Plan Premium') {
            return res.status(403).json({ html: `<div class="text-center p-4 text-slate-500">🔒 Solo Premium</div>` });
        }

        const { resumen } = req.body;
        if (!resumen) return res.status(400).json({ error: 'Faltan datos' });

        // PROMPT ESTÉTICO Y AMIGABLE
        const prompt = `
            Eres "Repleno AI", un consultor de negocios digital con una personalidad amable, clara y visual. Tu objetivo es ayudar a dueños de PYMES que no son expertos en tecnología.
            
            **DATOS DEL NEGOCIO:**
            ${JSON.stringify(resumen)}
            
            **TU MISIÓN:**
            Analiza estos datos y genera un reporte HTML limpio y atractivo visualmente. 
            
            **REGLAS DE ESTILO:**
            1. Usa lenguaje sencillo y motivador ("Tu producto estrella", "Ojo con esto").
            2. Usa EMOJIS para hacer la lectura amena.
            3. Usa las siguientes clases de Tailwind CSS para mantener la identidad de marca (Índigo/Violeta).
            4. Si falta información (ej: día peak no claro), haz una estimación educada o da un consejo general de oro.

            **ESTRUCTURA HTML REQUERIDA (Solo devuelve esto):**
            
            <div class="space-y-6 font-inter text-slate-700">
                
                <!-- 1. HEADER CON TEXTO DE BIENVENIDA -->
                <div class="bg-gradient-to-r from-indigo-500 to-purple-600 rounded-2xl p-6 text-white shadow-lg relative overflow-hidden">
                    <div class="relative z-10">
                        <h2 class="text-2xl font-bold flex items-center gap-2">👋 ¡Hola! Aquí está tu reporte</h2>
                        <p class="opacity-90 mt-2 text-indigo-50">He analizado tus movimientos recientes. Aquí tienes lo más importante.</p>
                    </div>
                    <!-- Decoración de fondo sutil -->
                    <div class="absolute right-0 top-0 h-32 w-32 bg-white opacity-10 rounded-full -mr-10 -mt-10 blur-2xl"></div>
                </div>

                <!-- 2. TARJETAS DE HALLAZGOS (Grid) -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    
                    <!-- Tarjeta: Lo Mejor -->
                    <div class="bg-white p-5 rounded-2xl border border-indigo-100 shadow-sm hover:shadow-md transition-shadow">
                        <div class="flex items-center gap-3 mb-3">
                            <div class="w-10 h-10 rounded-full bg-yellow-100 flex items-center justify-center text-xl">🏆</div>
                            <div>
                                <h3 class="font-bold text-slate-800 leading-tight">Tu Ganador</h3>
                                <span class="text-xs text-slate-400">Producto más vendido</span>
                            </div>
                        </div>
                        <p class="text-xl font-bold text-indigo-600 truncate">[Nombre Producto Estrella]</p>
                        <p class="text-sm text-slate-500 mt-1">Con <b>[Cantidad]</b> unidades vendidas.</p>
                        <div class="mt-3 pt-3 border-t border-slate-50 text-xs text-indigo-500 font-medium flex items-center gap-1">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path></svg>
                            Tendencia Alta los [Día de la semana]
                        </div>
                    </div>

                    <!-- Tarjeta: Atención -->
                    <div class="bg-white p-5 rounded-2xl border border-red-100 shadow-sm hover:shadow-md transition-shadow">
                        <div class="flex items-center gap-3 mb-3">
                            <div class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center text-xl">🚨</div>
                            <div>
                                <h3 class="font-bold text-slate-800 leading-tight">Atención Requerida</h3>
                                <span class="text-xs text-slate-400">Estado del inventario</span>
                            </div>
                        </div>
                        <p class="text-lg font-semibold text-slate-700">
                            [Si hay stock bajo: "Queda poco stock de..."]
                            [Si todo bien: "¡Todo en orden!"]
                        </p>
                        <p class="text-sm text-slate-500 mt-1">
                            [Nombre Producto Crítico o "Inventario saludable"]
                        </p>
                        <div class="mt-3 pt-3 border-t border-slate-50 text-xs text-red-500 font-medium">
                            💡 Sugerencia: [Acción breve de reabastecimiento]
                        </div>
                    </div>
                </div>

                <!-- 3. CONSEJO ESTRATÉGICO -->
                <div class="bg-slate-50 p-6 rounded-2xl border border-slate-200">
                    <h3 class="text-indigo-900 font-bold text-lg mb-2 flex items-center gap-2">
                        <span class="text-xl">💡</span> Consejo de Negocio
                    </h3>
                    <p class="text-slate-600 leading-relaxed text-sm">
                        [Escribe aquí un consejo estratégico, personalizado y accionable basado en los datos. Ejemplo: "Vimos que el viernes es tu día fuerte, asegúrate de recibir mercadería el miércoles..."]
                    </p>
                </div>

            </div>

            IMPORTANTE:
            - No uses markdown (\`\`\`).
            - Solo devuelve el HTML limpio.
        `;

        const result = await generateContentWithRetry(prompt);
        let cleanHtml = result.response.text().replace(/```html/g, '').replace(/```/g, '').trim();
        res.json({ html: cleanHtml });

    } catch (error) {
        console.error('Error IA:', error.message);
        const status = error.message.includes('429') ? 429 : 500;
        res.status(status).json({ error: 'Error consultando IA.' });
    }
});

// 3. CREAR TRANSACCIÓN
app.post('/crear-transaccion', async (req, res) => {
  try {
    if (!isFirebaseReady) return res.status(503).json({ error: 'Sistema de suscripciones no disponible.' });
    const { monto, plan, userId } = req.body;
    if (!monto || !plan || !userId) return res.status(400).json({ error: 'Datos incompletos' });

    const buyOrder = 'ORD-' + Math.floor(Math.random() * 100000000);
    const sessionId = 'SES-' + Date.now();
    const returnUrl = `http://localhost:${PORT}/retorno`;

    guardarTransaccion(sessionId, { plan, monto, userId });

    const tx = new WebpayPlus.Transaction(txOptions);
    const response = await tx.create(buyOrder, sessionId, monto, returnUrl);

    res.json({ url: response.url, token: response.token });
  } catch (error) {
    console.error('❌ Error Transbank:', error.message);
    res.status(500).json({ error: 'Error al conectar con Webpay.' });
  }
});

// 4. RETORNO TRANSACCIÓN
app.get('/retorno', async (req, res) => {
  try {
    const { token_ws, TBK_TOKEN, TBK_ORDEN_COMPRA } = req.query;

    if (TBK_TOKEN && !token_ws) return res.redirect(`/retorno.html?status=cancelled`);
    if (!token_ws && TBK_ORDEN_COMPRA) return res.redirect(`/retorno.html?status=rejected`);

    if (token_ws) {
      const tx = new WebpayPlus.Transaction(txOptions);
      const result = await tx.commit(token_ws);
      const sessionData = obtenerYBorrarTransaccion(result.session_id);
      
      if (result.status === 'AUTHORIZED' && result.response_code === 0 && sessionData.userId) {
        if (isFirebaseReady) {
            await db.collection('users').doc(sessionData.userId).update({
                plan: sessionData.plan,
                planStartDate: new Date().toISOString(),
                subscriptionStatus: 'active'
            });
        }
        
        const params = new URLSearchParams({
          status: 'success',
          amount: result.amount,
          plan: sessionData.plan,
          card: result.card_detail?.card_number || "XXXX",
          date: result.transaction_date || new Date().toISOString()
        });
        return res.redirect(`/retorno.html?${params.toString()}`);
      }
      return res.redirect(`/retorno.html?status=rejected`);
    }
    res.redirect('/retorno.html?status=invalid');
  } catch (error) {
    console.error("❌ Error Retorno:", error.message);
    res.redirect('/retorno.html?status=error');
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 SERVIDOR REPLENO ACTIVO en http://localhost:${PORT}`);
});