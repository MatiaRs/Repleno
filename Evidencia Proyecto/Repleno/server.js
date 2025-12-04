import 'dotenv/config';
import express from 'express';
import pkg from 'transbank-sdk';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { GoogleGenerativeAI } from "@google/generative-ai";

const { WebpayPlus, IntegrationCommerceCodes, IntegrationApiKeys, Environment, Options } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- SISTEMA ANTI-CRASH (NUEVO) ---
// Evita que el servidor se apague si Firebase rechaza conexiones por cuota
process.on('uncaughtException', (err) => {
    console.error('⚠️ [CRITICAL] Error no capturado:', err.message);
    // No salimos del proceso, lo mantenemos vivo
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [CRITICAL] Promesa rechazada sin manejo:', reason);
    // Mantenemos el servidor vivo
});

// --- 1. INICIALIZACIÓN DE FIREBASE ---
let db = null;
let adminAuth = null;
let isFirebaseReady = false;

function initFirebase() {
    try {
        let serviceAccount;
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        } else {
            const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
            if (existsSync(serviceAccountPath)) {
                serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
            } else {
                console.warn("⚠️ No se encontró serviceAccountKey.json");
                return;
            }
        }

        if (getApps().length === 0) {
            initializeApp({ credential: cert(serviceAccount) });
        }
        
        db = getFirestore();
        adminAuth = getAuth();
        isFirebaseReady = true;
        console.log("🔥 Firebase Admin SDK conectado.");

    } catch (error) {
        console.error("❌ Error Fatal Firebase:", error.message);
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

// Middleware DB Check
const requireDB = (req, res, next) => {
    if (!isFirebaseReady || !db) return res.status(503).json({ error: 'DB no disponible' });
    next();
};

// Middleware para manejo de errores de Cuota
const handleQuotaError = (err, res) => {
    console.error("🔥 Error Firebase:", err.message);
    if (err.message && err.message.includes('Quota exceeded')) {
        return res.status(429).json({ error: 'El servidor está saturado por hoy (Cuota Firebase). Intenta mañana.' });
    }
    return res.status(500).json({ error: 'Error interno del servidor.' });
};

// --- TAREA PROGRAMADA ---
setInterval(async () => {
    if (!isFirebaseReady) return;
    const now = new Date().toISOString();
    try {
        const snapshot = await db.collection('users').where('deletionScheduledAt', '<=', now).get();
        if (!snapshot.empty) {
            for (const doc of snapshot.docs) {
                const uid = doc.id;
                try {
                    try { await adminAuth.deleteUser(uid); } catch (authErr) { }
                    await deleteCollection(db, `business_data/${uid}/transactions`, 500);
                    await db.collection('business_data').doc(uid).delete();
                    await db.collection('users').doc(uid).delete();
                    console.log(`🗑️ Usuario ${uid} eliminado.`);
                } catch (err) { console.error(err); }
            }
        }
    } catch (error) { 
        // Silenciamos error de cuota en el background para no llenar la consola
        if(!error.message.includes('Quota')) console.error(error); 
    }
}, 3600000); 

// Helper IA
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

// ================= ENDPOINTS ADMIN =================

app.delete('/api/admin/users/:uid', requireDB, async (req, res) => {
    try {
        const uid = req.params.uid;
        try { await adminAuth.deleteUser(uid); } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
        await deleteCollection(db, `business_data/${uid}/transactions`, 500);
        await db.collection('business_data').doc(uid).delete();
        await db.collection('users').doc(uid).delete();
        res.json({ success: true });
    } catch (e) { handleQuotaError(e, res); }
});

app.get('/api/admin/tickets', requireDB, async (req, res) => {
    try {
        const userId = req.headers['user-id'];
        if (!userId) return res.status(401).json({ error: 'No autorizado' });

        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists || userDoc.data().role !== 'admin') {
            return res.status(403).json({ error: 'Acceso denegado' });
        }

        const snapshot = await db.collection('support_tickets')
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();

        const tickets = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json({ tickets });
    } catch (error) {
        handleQuotaError(error, res);
    }
});

app.post('/api/admin/tickets/:id/responder', requireDB, async (req, res) => {
    try {
        const ticketId = req.params.id;
        const { response } = req.body;
        const userId = req.headers['user-id'];

        if (!userId || !response) return res.status(400).json({ error: "Datos incompletos" });

        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists || userDoc.data().role !== 'admin') {
            return res.status(403).json({ error: 'No autorizado' });
        }

        await db.collection('support_tickets').doc(ticketId).update({
            response: response,
            status: 'resolved',
            respondedAt: new Date().toISOString(),
            adminResponderId: userId
        });

        res.json({ success: true, message: "Respuesta enviada." });
    } catch (error) {
        handleQuotaError(error, res);
    }
});

// ================= ENDPOINTS CLIENTE =================

app.post('/api/crear-ticket', requireDB, async (req, res) => {
    try {
        const { ticketData } = req.body;
        const userId = req.headers['user-id'];

        if (!userId || !ticketData) return res.status(400).json({ error: "Datos incompletos" });

        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) return res.status(404).json({ error: "Usuario no encontrado" });

        const finalTicketData = {
            ...ticketData,
            topic: ticketData.topic || "Consulta General",
            createdAt: new Date().toISOString(),
            status: 'open',
            serverReceived: true
        };

        await db.collection('support_tickets').add(finalTicketData);
        res.json({ success: true });
    } catch (error) {
        handleQuotaError(error, res);
    }
});

app.get('/api/mis-tickets', requireDB, async (req, res) => {
    try {
        const userId = req.headers['user-id'];
        if (!userId) return res.status(401).json({ error: 'No autorizado' });

        const snapshot = await db.collection('support_tickets')
            .where('userId', '==', userId)
            .get();

        const tickets = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) 
            .slice(0, 10); 

        res.json({ tickets });
    } catch (error) {
        handleQuotaError(error, res);
    }
});

app.post('/api/consultar-ia', requireDB, async (req, res) => {
    try {
        if (!GEMINI_API_KEY) return res.status(500).json({ error: "Falta API Key." });
        
        const userId = req.headers['user-id'];
        if (!userId) return res.status(401).json({ error: 'No autorizado' });

        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists || userDoc.data().plan !== 'Plan Premium') {
            return res.status(403).json({ html: `<div class="text-center p-4 text-slate-500">🔒 Función Premium.</div>` });
        }

        const { resumen } = req.body;
        if (!resumen) return res.status(400).json({ error: 'Faltan datos.' });

        // Lógica simplificada IA
        const daysOfWeek = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
        const getPeakDayAndAdvice = (item) => {
            const pattern = item.salesPattern || {};
            if (Object.keys(pattern).length === 0) return null;
            let peakQty = 0, peakDayIndex = -1;
            Object.entries(pattern).forEach(([d, q]) => { if (q > peakQty) { peakQty = q; peakDayIndex = parseInt(d); } });
            if (peakDayIndex === -1) return null;
            return {
                peakDay: daysOfWeek[peakDayIndex],
                peakQty: peakQty,
                suggestedRepurchaseQty: Math.ceil(peakQty * 1.20), 
                repurchaseDay: daysOfWeek[(peakDayIndex + 7 - 3) % 7],
                maxOverstockLimit: Math.ceil((Object.values(pattern).reduce((a, b) => a + b, 0) / 7) * 21), 
            };
        };

        const topSellerAdvice = resumen.topSeller ? getPeakDayAndAdvice(resumen.topSeller) : null;
        const criticalItemsAdvice = resumen.lowStockItems.map(item => ({...item, advice: getPeakDayAndAdvice(item)})).filter(item => item.advice);
        const topSellerAnalysis = resumen.topSeller || {}; 

        const prompt = `
            Eres "Repleno AI". Genera reporte HTML Tailwind.
            DATOS: Top: ${JSON.stringify(resumen.topSeller)}, Advice: ${JSON.stringify(topSellerAdvice)}, Critical: ${JSON.stringify(criticalItemsAdvice)}.
            
            <div class="space-y-6 font-inter text-slate-700">
                <div class="bg-gradient-to-r from-indigo-600 to-purple-600 rounded-2xl p-6 text-white shadow-lg">
                    <h2 class="text-2xl font-bold">🎯 Estrategia Logística Detallada</h2>
                    <p class="opacity-90 mt-1 text-indigo-100 text-sm">Instrucciones precisas para optimizar tu inventario.</p>
                </div>
                <div class="bg-white p-5 rounded-2xl border border-indigo-100 shadow-sm">
                    <h3 class="font-bold text-indigo-700 mb-4">🏆 Producto Estrella: ${resumen.topSeller?.name || 'N/A'}</h3>
                    <div class="grid grid-cols-2 gap-4 text-sm">
                        <div><p class="text-slate-500">Ventas:</p><p class="font-bold">${topSellerAnalysis.qty || 0} un.</p></div>
                        <div><p class="text-slate-500">Día Peak:</p><p class="font-bold text-red-500">${topSellerAdvice?.peakDay || 'N/A'}</p></div>
                    </div>
                </div>
                ${criticalItemsAdvice.length > 0 ? `<div class="space-y-3">${criticalItemsAdvice.map(i => `
                    <div class="bg-red-50 p-4 rounded-xl border border-red-100"><p class="font-bold text-red-700">${i.name}</p><p class="text-xs">Pedir: ${i.advice.suggestedRepurchaseQty} un. el ${i.advice.repurchaseDay}</p></div>
                `).join('')}</div>` : '<div class="bg-green-50 p-4 rounded-xl text-green-700">Inventario saludable.</div>'}
            </div>
        `;

        const result = await generateContentWithRetry(prompt);
        let cleanHtml = result.response.text().replace(/```html/g, '').replace(/```/g, '').trim();
        res.json({ html: cleanHtml });

    } catch (error) {
        if (error.message.includes('403')) return res.status(403).json({ error: 'Llave de IA revocada.' });
        handleQuotaError(error, res);
    }
});

// Transbank
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
  } catch (error) { res.status(500).json({ error: 'Error Transbank.' }); }
});

app.get('/retorno', async (req, res) => {
  try {
    const { token_ws, TBK_TOKEN } = req.query;
    if (!token_ws) return res.redirect(`/retorno.html?status=cancelled`);
    const tx = new WebpayPlus.Transaction(txOptions);
    const result = await tx.commit(token_ws);
    const sessionData = obtenerYBorrarTransaccion(result.session_id);
    if (result.status === 'AUTHORIZED' && sessionData.userId && isFirebaseReady) {
        await db.collection('users').doc(sessionData.userId).update({ plan: sessionData.plan, planStartDate: new Date().toISOString(), subscriptionStatus: 'active' });
        const params = new URLSearchParams({ status: 'success', amount: result.amount, plan: sessionData.plan });
        return res.redirect(`/retorno.html?${params.toString()}`);
    }
    return res.redirect(`/retorno.html?status=rejected`);
  } catch (error) { res.redirect('/retorno.html?status=error'); }
});

app.listen(PORT, () => { console.log(`🚀 SERVIDOR ACTIVO: http://localhost:${PORT}`); });