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

// --- 1. INICIALIZACIÓN DE FIREBASE (DIAGNÓSTICO DE SEGURIDAD) ---
let db = null;
let adminAuth = null;
let isFirebaseReady = false;

function initFirebase() {
    console.log("\n🔍 --- INICIANDO DIAGNÓSTICO DE CREDENCIALES ---");
    try {
        let serviceAccount;
        // Prioridad 1: Variable de entorno
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            console.log("✅ [Fuente] Variable de Entorno detectada.");
        } 
        // Prioridad 2: Archivo local
        else {
            const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
            console.log(`📂 [Buscando archivo en]: ${serviceAccountPath}`);
            
            if (existsSync(serviceAccountPath)) {
                const rawData = readFileSync(serviceAccountPath, 'utf8');
                serviceAccount = JSON.parse(rawData);
                console.log("✅ [Archivo] 'serviceAccountKey.json' encontrado y leído.");
                
                // Verificación de seguridad básica
                if (!serviceAccount.project_id || !serviceAccount.private_key) {
                    throw new Error("El archivo JSON parece estar incompleto o corrupto.");
                }
                console.log(`🆔 [Proyecto ID]: ${serviceAccount.project_id}`);
                console.log(`📧 [Email Servicio]: ${serviceAccount.client_email}`);
            } else {
                console.error("❌ [ERROR FATAL] No se encontró 'serviceAccountKey.json'.");
                console.warn("   -> Asegúrate de que el archivo esté en la misma carpeta que server.js");
                return;
            }
        }

        // Inicializar
        if (getApps().length === 0) {
            initializeApp({ credential: cert(serviceAccount) });
        }
        
        db = getFirestore();
        adminAuth = getAuth();
        isFirebaseReady = true;
        console.log("🔥 [Firebase] Conexión establecida correctamente.");
        console.log("---------------------------------------------------\n");

    } catch (error) {
        console.error("❌ [Firebase] Error de Inicialización:", error.message);
        console.warn("⚠️ MODO DEGRADADO: Las funciones administrativas (borrar usuarios) NO funcionarán.");
    }
}

// Ejecutar inicialización
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
// Servir archivos estáticos (HTML, CSS, JS del cliente)
app.use(express.static(path.join(__dirname)));

// --- 4. TRANSBANK SETUP ---
const txOptions = new Options(
    IntegrationCommerceCodes.WEBPAY_PLUS, 
    IntegrationApiKeys.WEBPAY, 
    Environment.Integration
);

const TX_FILE = path.join(__dirname, 'transactions_temp.json');

// --- HELPERS DE TRANSACCIÓN ---
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
        console.error("Error guardando tx temporal:", e.message);
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
                if (dbCache[k].timestamp && (now - dbCache[k].timestamp > 86400000)) {
                    delete dbCache[k];
                }
            });
            writeFileSync(TX_FILE, JSON.stringify(dbCache, null, 2));
            return data;
        }
    } catch (e) {
        console.error("Error leyendo tx temporal:", e.message);
    }
    return {};
}

// --- HELPER DE BORRADO RECURSIVO (CRÍTICO PARA ADMIN) ---
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
    if (snapshot.size === 0) {
        resolve();
        return;
    }
    const batch = dbRef.batch();
    snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
    });
    await batch.commit();
    process.nextTick(() => deleteQueryBatch(dbRef, query, resolve));
}

// --- MIDDLEWARE DE DB CHECK ---
const requireDB = (req, res, next) => {
    if (!isFirebaseReady || !db) {
        console.error(`⛔ Acceso denegado a DB en ${req.path} (Firebase no inicializado)`);
        return res.status(503).json({ error: 'La base de datos no está conectada. Revisa las credenciales del servidor.' });
    }
    next();
};

// --- TAREA PROGRAMADA: LIMPIEZA DE CUENTAS (Cada 1 Hora) ---
setInterval(async () => {
    if (!isFirebaseReady) return;
    const now = new Date().toISOString();
    try {
        const snapshot = await db.collection('users')
            .where('deletionScheduledAt', '<=', now)
            .get();

        if (!snapshot.empty) {
            console.log(`🗑️ [Cleanup] Eliminando ${snapshot.size} cuentas expiradas...`);
            for (const doc of snapshot.docs) {
                const uid = doc.id;
                try {
                    await adminAuth.deleteUser(uid).catch(() => {}); 
                    await deleteCollection(db, `business_data/${uid}/transactions`, 500);
                    await db.collection('business_data').doc(uid).delete();
                    await db.collection('users').doc(uid).delete();
                    console.log(`✅ Usuario ${uid} eliminado por expiración.`);
                } catch (err) {
                    console.error(`❌ Error borrando usuario expirado ${uid}:`, err.message);
                }
            }
        }
    } catch (error) {
        console.error("Error en tarea de limpieza automática:", error.message);
    }
}, 3600000); 

// --- HELPER: Reintentos IA ---
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function generateContentWithRetry(prompt) {
    let retries = 0;
    while (true) {
        try {
            return await model.generateContent(prompt);
        } catch (error) {
            if (retries >= 3) throw error;
            console.warn(`⚠️ IA Busy, reintentando (${retries + 1}/3)...`);
            await delay(1000 * (retries + 1));
            retries++;
        }
    }
}

// ================= ENDPOINTS =================

// 1. ELIMINACIÓN INMEDIATA (Usado por Admin Panel)
app.delete('/api/admin/users/:uid', requireDB, async (req, res) => {
    try {
        const uid = req.params.uid;
        console.log(`👮 [Admin] Intentando borrar usuario: ${uid}`);

        // Intentar borrar de Auth primero
        try { 
            await adminAuth.deleteUser(uid); 
            console.log("   ✅ Auth eliminado.");
        } catch (e) { 
            // MEJORA CRÍTICA: Si el usuario no existe, NO detenemos el proceso.
            // Solo lanzamos error si es un problema de credenciales o servidor.
            if (e.code === 'auth/user-not-found') {
                console.log("   ⚠️ El usuario no existía en Auth (ya borrado), continuando con limpieza de DB...");
            } else {
                console.error("   ❌ Error borrando Auth:", e.code, e.message);
                // Si es otro error de auth (ej: credenciales inválidas), ahí sí avisamos
                if (e.code && e.code.startsWith('auth/') && e.code !== 'auth/user-not-found') throw e;
            }
        }
        
        // 2. Eliminar Subcolección
        await deleteCollection(db, `business_data/${uid}/transactions`, 500);
        
        // 3. Eliminar Documentos
        await db.collection('business_data').doc(uid).delete();
        await db.collection('users').doc(uid).delete();
        
        console.log(`   ✅ Datos eliminados correctamente.`);
        res.json({ success: true });

    } catch (e) { 
        console.error("❌ FALLO CRÍTICO EN ADMIN DELETE:", e);
        res.status(500).json({ error: `Error del servidor: ${e.message}` }); 
    }
});

// 2. CONSULTORÍA IA (Visual y Amigable)
app.post('/api/consultar-ia', requireDB, async (req, res) => {
    try {
        if (!GEMINI_API_KEY) return res.status(500).json({ error: "Falta API Key de Gemini en el servidor." });
        
        const userId = req.headers['user-id'];
        if (!userId) return res.status(401).json({ error: 'No autorizado' });

        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists || userDoc.data().plan !== 'Plan Premium') {
            return res.status(403).json({ html: `<div class="text-center p-4 text-slate-500">🔒 Esta función requiere Plan Premium.</div>` });
        }

        const { resumen } = req.body;
        if (!resumen) return res.status(400).json({ error: 'Faltan datos para analizar.' });

        const prompt = `
            Eres "Repleno AI", un consultor de negocios digital experto pero muy amigable.
            Tu cliente es dueño de una PYME y necesita consejos claros, no tecnicismos.
            
            **DATOS DEL NEGOCIO:**
            ${JSON.stringify(resumen)}

            **TAREA:**
            Analiza los datos y genera un reporte HTML visualmente atractivo usando clases de Tailwind CSS.

            **ESTRUCTURA HTML REQUERIDA (Devuelve solo el HTML dentro del div):**
            <div class="space-y-6 font-inter text-slate-700">
                <!-- Header -->
                <div class="bg-gradient-to-r from-indigo-500 to-purple-600 rounded-2xl p-6 text-white shadow-lg relative overflow-hidden">
                    <h2 class="text-2xl font-bold flex items-center gap-2">👋 ¡Hola! Tu reporte está listo</h2>
                    <p class="opacity-90 mt-2 text-indigo-50">He encontrado algunos puntos clave en tu inventario.</p>
                </div>

                <!-- Grid de Datos -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="bg-white p-5 rounded-2xl border border-indigo-100 shadow-sm">
                        <div class="flex items-center gap-3 mb-2"><span class="text-2xl">🏆</span><h3 class="font-bold text-slate-800">Producto Estrella</h3></div>
                        <p class="text-xl font-bold text-indigo-600">[Nombre Producto]</p>
                        <p class="text-xs text-slate-500 mt-1">Es el favorito de tus clientes.</p>
                    </div>
                    <div class="bg-white p-5 rounded-2xl border border-red-100 shadow-sm">
                        <div class="flex items-center gap-3 mb-2"><span class="text-2xl">🚨</span><h3 class="font-bold text-slate-800">Atención Stock</h3></div>
                        <p class="text-lg font-bold text-slate-700">[Producto Crítico o "Todo OK"]</p>
                        <p class="text-xs text-red-500 font-medium mt-1">[Acción sugerida breve]</p>
                    </div>
                </div>

                <!-- Consejo -->
                <div class="bg-slate-50 p-6 rounded-2xl border border-slate-200">
                    <h3 class="text-indigo-900 font-bold text-lg mb-2">💡 Consejo de Estrategia</h3>
                    <p class="text-slate-600 leading-relaxed text-sm">[Consejo personalizado, útil y motivador]</p>
                </div>
            </div>
        `;

        const result = await generateContentWithRetry(prompt);
        let cleanHtml = result.response.text().replace(/```html/g, '').replace(/```/g, '').trim();
        res.json({ html: cleanHtml });

    } catch (error) {
        console.error('Error IA:', error.message);
        const status = error.message.includes('429') ? 429 : 500;
        res.status(status).json({ error: 'El asistente está ocupado. Intenta en unos segundos.' });
    }
});

// 3. CREAR TRANSACCIÓN (Webpay)
app.post('/crear-transaccion', async (req, res) => {
  try {
    if (!isFirebaseReady) return res.status(503).json({ error: 'Sistema de suscripciones en mantenimiento.' });
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
    res.status(500).json({ error: 'Error al conectar con el banco.' });
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

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 SERVIDOR REPLENO ACTIVO en http://localhost:${PORT}`);
  console.log(`==================================================`);
});