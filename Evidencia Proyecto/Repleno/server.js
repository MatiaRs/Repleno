import 'dotenv/config';
import express from 'express';
import pkg from 'transbank-sdk';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync, existsSync, writeFileSync } from 'fs'; // Agregado writeFileSync
import { GoogleGenerativeAI } from "@google/generative-ai";

const { WebpayPlus, IntegrationCommerceCodes, IntegrationApiKeys, Environment, Options } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- GESTIÓN DE TRANSACCIONES PERSISTENTE ---
// Esto evita que se pierdan los datos del plan si reinicias el servidor
const TX_FILE = path.join(__dirname, 'transactions_temp.json');

function guardarTransaccion(sessionId, data) {
    let db = {};
    if (existsSync(TX_FILE)) {
        try { db = JSON.parse(readFileSync(TX_FILE, 'utf8')); } catch (e) {}
    }
    db[sessionId] = data;
    writeFileSync(TX_FILE, JSON.stringify(db));
}

function obtenerYBorrarTransaccion(sessionId) {
    if (!existsSync(TX_FILE)) return {};
    try {
        const db = JSON.parse(readFileSync(TX_FILE, 'utf8'));
        const data = db[sessionId];
        if (data) {
            delete db[sessionId];
            writeFileSync(TX_FILE, JSON.stringify(db));
            return data;
        }
    } catch (e) { console.error("Error leyendo transacciones:", e); }
    return {};
}

// --- FIREBASE ---
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch (e) { console.error("Error ENV Firebase:", e.message); }
} else {
    const localPath = path.join(__dirname, 'serviceAccountKey.json');
    if (existsSync(localPath)) {
        try { serviceAccount = JSON.parse(readFileSync(localPath, 'utf8')); } catch (e) { console.error("Error File Firebase:", e.message); }
    }
}

if (serviceAccount) {
    try { initializeApp({ credential: cert(serviceAccount) }); } catch (e) { if (!/already exists/.test(e.message)) console.error(e); }
}
const db = getFirestore();
const adminAuth = getAuth();

// --- GEMINI ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const commerceCode = IntegrationCommerceCodes.WEBPAY_PLUS;
const apiKey = IntegrationApiKeys.WEBPAY;
const environment = Environment.Integration;

function createTx() { return new WebpayPlus.Transaction(new Options(commerceCode, apiKey, environment)); }

// --- DIAGNÓSTICO SILENCIOSO ---
// Solo probamos si hay clave, pero no hacemos log ruidoso para no gastar cuota en cada reinicio
if (GEMINI_API_KEY) console.log("✅ API Key de Gemini configurada.");


// --- ENDPOINTS ---

app.post('/api/consultar-ia', async (req, res) => {
    try {
        const userId = req.headers['user-id'];
        if (!userId) return res.status(401).json({ error: 'No autorizado' });

        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists || userDoc.data().plan !== 'Plan Premium') {
            return res.status(403).json({ html: '<div class="p-4 bg-red-50 text-red-800 rounded-lg">🔒 Solo Plan Premium</div>' });
        }

        const { resumen } = req.body;
        const prompt = `Actúa como consultor experto. Analiza: ${JSON.stringify(resumen)}. Genera HTML Tailwind. Estructura: Saludo, Hallazgo, Acción. Sé breve.`;

        const result = await model.generateContent(prompt);
        const text = result.response.text().replace(/```html/g, '').replace(/```/g, '');
        
        // Limpieza simple
        const lastDiv = text.lastIndexOf('</div>');
        res.json({ html: lastDiv !== -1 ? text.substring(0, lastDiv + 6) : text });

    } catch (error) {
        console.error('Gemini Error:', error.message);
        // Manejo específico de CUOTA EXCEDIDA
        if (error.message.includes('429') || error.message.includes('Quota') || error.message.includes('RESOURCE_EXHAUSTED')) {
            return res.status(429).json({ error: 'Cuota de IA excedida. Intenta en unos minutos.' });
        }
        res.status(500).json({ error: 'La IA está dormida. Intenta luego.' });
    }
});

app.post('/crear-transaccion', async (req, res) => {
    try {
        const { monto, plan, userId } = req.body;
        if (!monto || !plan || !userId) return res.status(400).json({ error: 'Faltan datos' });

        const buyOrder = 'ORD-' + Date.now();
        const sessionId = 'SES-' + Date.now();
        const returnUrl = 'http://localhost:3000/retorno';

        // GUARDAR EN ARCHIVO (Sobrevive reinicios)
        guardarTransaccion(sessionId, { plan, monto, userId });

        const tx = createTx();
        const response = await tx.create(buyOrder, sessionId, monto, returnUrl);
        res.json({ url: response.url, token: response.token });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/retorno', async (req, res) => {
    try {
        const { token_ws, TBK_TOKEN } = req.query;
        if (TBK_TOKEN) return res.redirect('/retorno.html?status=cancelled');
        if (!token_ws) return res.redirect('/retorno.html?status=invalid');

        const tx = createTx();
        const result = await tx.commit(token_ws);
        
        // RECUPERAR DE ARCHIVO
        const storedData = obtenerYBorrarTransaccion(result.session_id);
        const { plan, userId } = storedData;

        if (result.status === 'AUTHORIZED' && userId && plan) {
            await db.collection('users').doc(userId).update({
                plan: plan,
                planStartDate: new Date().toISOString(),
                subscriptionStatus: 'active'
            });
            
            const params = new URLSearchParams({
                status: 'success',
                amount: result.amount,
                plan: plan, // Ahora sí debería llegar siempre
                card: result.card_detail?.card_number || '****',
                date: result.transaction_date || new Date().toISOString()
            });
            return res.redirect(`/retorno.html?${params.toString()}`);
        }
        res.redirect('/retorno.html?status=rejected');
    } catch (e) {
        console.error(e);
        res.redirect('/retorno.html?status=error');
    }
});

// --- ELIMINACIÓN ADMIN ---
app.delete('/api/admin/users/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;
        await adminAuth.deleteUser(uid);
        await db.collection('users').doc(uid).delete();
        const subCols = await db.collection('business_data').doc(uid).listCollections();
        for (const col of subCols) {
            const docs = await col.listDocuments();
            docs.forEach(d => d.delete());
        }
        await db.collection('business_data').doc(uid).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(3000, () => console.log("🚀 Servidor listo en http://localhost:3000"));