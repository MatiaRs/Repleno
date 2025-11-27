import 'dotenv/config'; // IMPORTANTE: Esto carga las variables del archivo .env
import express from 'express';
import pkg from 'transbank-sdk';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// --- FIREBASE ADMIN ---
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth'; // Importamos Auth para gestión de usuarios
import { readFileSync, existsSync } from 'fs'; // Añadimos existsSync

// --- IMPORTAR GEMINI ---
import { GoogleGenerativeAI } from "@google/generative-ai";

const { WebpayPlus, IntegrationCommerceCodes, IntegrationApiKeys, Environment, Options } = pkg;

// --- CONFIGURACIÓN DE RUTAS ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CONFIGURACIÓN HÍBRIDA DE CREDENCIALES FIREBASE ---
// Intentamos leer primero de la variable de entorno (Producción/GitHub)
// Si no existe, buscamos el archivo local (Desarrollo)
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        // Si está en el .env, lo parseamos
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("✅ Credenciales de Firebase cargadas desde Variable de Entorno.");
    } catch (error) {
        console.error("❌ Error al leer FIREBASE_SERVICE_ACCOUNT del .env:", error.message);
    }
} else {
    // Fallback: Intentar leer archivo físico
    const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
    if (existsSync(serviceAccountPath)) {
        try {
            serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
            console.log("✅ Credenciales de Firebase cargadas desde archivo local.");
        } catch (error) {
            console.error("❌ Error al leer serviceAccountKey.json:", error.message);
        }
    } else {
        console.warn("⚠️ No se encontró configuración de Firebase (ni en .env ni archivo local).");
    }
}

// --- INICIALIZAR FIREBASE ---
if (serviceAccount) {
    try {
        initializeApp({
            credential: cert(serviceAccount)
        });
    } catch (error) {
        if (!/already exists/.test(error.message)) {
            console.error('Error inicializando Firebase Admin:', error);
        }
    }
}

const db = getFirestore();
const adminAuth = getAuth(); // Inicializamos Admin Auth

// --- CONFIGURAR GEMINI (AHORA OCULTO) ---
// La clave se carga desde process.env.GEMINI_API_KEY gracias a 'dotenv/config'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.error("❌ ERROR CRÍTICO: No se encontró la variable GEMINI_API_KEY.");
    console.error("   Asegúrate de crear un archivo .env en la raíz y agregar: GEMINI_API_KEY=tu_clave");
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || ""); // Evita crash si es undefined al inicio

// Usamos el modelo flash 2.0 que es rápido, bueno y al que tienes acceso
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Aumentado límite para bases de datos grandes
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const commerceCode = IntegrationCommerceCodes.WEBPAY_PLUS;
const apiKey = IntegrationApiKeys.WEBPAY;
const environment = Environment.Integration;

const tempTransactionStorage = {};

function createTx() {
  return new WebpayPlus.Transaction(new Options(commerceCode, apiKey, environment));
}

// --- DIAGNÓSTICO AL INICIAR ---
async function probarGemini() {
    if (!GEMINI_API_KEY) return; // Saltamos si no hay key para evitar errores masivos en consola

    console.log("\n🤖 --- INICIANDO DIAGNÓSTICO DE IA ---");
    try {
        const result = await model.generateContent("Di 'OK'");
        const response = await result.response;
        console.log("✅ PRUEBA EXITOSA: Gemini respondió:", response.text().trim());
    } catch (error) {
        console.error("❌ PRUEBA FALLIDA.", error.message);
    }
    console.log("🤖 --- FIN DIAGNÓSTICO ---\n");
}
probarGemini();


// --- ENDPOINT: ELIMINACIÓN COMPLETA DE USUARIO (Para Panel Admin) ---
app.delete('/api/admin/users/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;
        console.log(`Iniciando eliminación completa para: ${uid}`);

        // 1. Eliminar de Firebase Authentication (Libera el correo para registro nuevo)
        await adminAuth.deleteUser(uid);
        console.log(`- Usuario eliminado de Auth`);

        // 2. Eliminar documento de perfil en Firestore (colección 'users')
        await db.collection('users').doc(uid).delete();
        console.log(`- Documento de perfil eliminado`);

        // 3. Eliminar datos de negocio (colección 'business_data')
        // Primero borramos las transacciones dentro de la subcolección
        const transactionsRef = db.collection('business_data').doc(uid).collection('transactions');
        const snapshot = await transactionsRef.get();
        
        if (!snapshot.empty) {
            const batch = db.batch();
            snapshot.docs.forEach((doc) => {
                batch.delete(doc.ref);
            });
            await batch.commit();
            console.log(`- ${snapshot.size} transacciones eliminadas`);
        }
        
        // Finalmente borramos el documento padre en business_data
        await db.collection('business_data').doc(uid).delete();

        res.json({ success: true, message: 'Usuario y datos eliminados completamente.' });

    } catch (error) {
        console.error('Error eliminando usuario:', error);
        res.status(500).json({ error: error.message });
    }
});


// --- ENDPOINT: CONSULTORÍA IA SEGURA (Solo Premium) ---
app.post('/api/consultar-ia', async (req, res) => {
    try {
        // 1. Seguridad: Obtener ID del usuario desde los headers
        const userId = req.headers['user-id'];
        
        if (!userId) {
            return res.status(401).json({ error: 'Usuario no identificado.' });
        }

        // 2. Seguridad: Verificar el plan en Firebase antes de gastar recursos de IA
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data();

        // Si no existe el usuario o su plan no es Premium, denegar acceso
        if (!userData || userData.plan !== 'Plan Premium') {
            return res.status(403).json({ 
                html: `
                <div class="p-6 bg-white rounded-2xl border border-red-100 shadow-sm text-center">
                    <div class="w-12 h-12 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-3 text-2xl">🔒</div>
                    <h3 class="text-red-600 font-bold text-lg">Acceso Restringido</h3>
                    <p class="text-slate-600 mt-2 text-sm">
                        El Asistente con IA avanzada es exclusivo para socios <b>Premium</b>.
                    </p>
                    <p class="text-slate-500 mt-4 text-xs">Actualiza tu plan para desbloquear análisis estratégicos.</p>
                </div>
                `
            });
        }

        // 3. Si es Premium, proceder con el análisis
        const { resumen } = req.body;

        const prompt = `
            Eres el **Socio Estratégico de Operaciones** de este negocio. Tienes acceso a datos reales de transacciones.
            **TU MISIÓN:** No hagas suposiciones generales. Analiza matemáticamente los patrones de los datos proporcionados.

            **DATOS DEL NEGOCIO:**
            ${JSON.stringify(resumen)}

            **INSTRUCCIONES DE ANÁLISIS PROFUNDO:**

            1.  **DETECTIVE DE PICOS DE VENTA (Análisis Real):**
                * Observa el campo 'topSeller.salesByDay'. ¿Cuál es el día de la semana con el número más alto? ESE es el "Día Peak".
                * Calcula la diferencia entre el Día Peak y el día más bajo. Úsalo para explicar la volatilidad.

            2.  **MOTOR DE REABASTECIMIENTO INTELIGENTE (Cálculo Logístico):**
                * Para los productos en 'lowStockItems':
                * Toma su 'qty' (stock actual).
                * Estima una 'velocidad de venta diaria' basada en el historial general.
                * **FÓRMULA MAESTRA:** Si (Stock Actual < Velocidad Venta * 3 días), la alerta es CRÍTICA.
                * **Estrategia de Compra:** Recomienda comprar stock 2 días ANTES del "Día Peak" identificado en el punto 1. Si el Día Peak es Viernes, sugiere comprar el Miércoles.

            3.  **IDENTIDAD VISUAL (Repleno Style):**
                * Genera HTML puro con clases Tailwind CSS.
                * Usa iconos de Phosphor o Emojis para cada sección.
                * Usa negritas (<b>) para números y fechas específicas.
                * Usa cursiva (<i>) para insights o "clues".

            **ESTRUCTURA HTML REQUERIDA:**

            <div class="space-y-6 font-inter">
                <!-- Header con Insight Principal -->
                <div class="bg-gradient-to-r from-indigo-600 to-violet-600 p-6 rounded-2xl shadow-lg text-white">
                    <div class="flex items-center gap-3 mb-2">
                        <span class="text-2xl">🧠</span>
                        <h3 class="font-bold text-lg">Análisis de Inteligencia</h3>
                    </div>
                    <p class="text-indigo-100 leading-relaxed">
                        Hola. He analizado tus movimientos. Tu patrón de ventas indica que el <b>[Día Peak Real]</b> es tu día más fuerte.
                    </p>
                </div>

                <!-- Grid de Datos Duros -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <!-- Tarjeta: El Ganador -->
                    <div class="bg-white p-5 rounded-xl border border-slate-100 shadow-sm hover:shadow-md transition-shadow">
                        <h4 class="text-xs font-bold text-indigo-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                            <span>🏆</span> MVP de la Semana
                        </h4>
                        <p class="text-slate-800 font-bold text-xl">[Nombre Producto Top]</p>
                        <div class="mt-3 text-sm text-slate-600 bg-slate-50 p-3 rounded-lg">
                            <p>Este producto se vende un <b>[X]%</b> más los <b>[Día Peak]</b> que el resto de la semana.</p>
                        </div>
                    </div>

                    <!-- Tarjeta: La Amenaza (Stock Bajo) -->
                    <div class="bg-white p-5 rounded-xl border border-red-100 shadow-sm hover:shadow-md transition-shadow">
                        <h4 class="text-xs font-bold text-red-500 uppercase tracking-wider mb-2 flex items-center gap-2">
                            <span>🚨</span> Riesgo de Quiebre
                        </h4>
                        <!-- Iterar aquí solo el producto más crítico -->
                        <p class="text-slate-800 font-bold text-xl">[Nombre Producto Bajo]</p>
                        <p class="text-sm text-slate-500 mt-1">Quedan solo <b>[Qty]</b> unidades.</p>
                        <div class="mt-3 text-sm text-red-600 bg-red-50 p-3 rounded-lg flex items-start gap-2">
                            <span class="mt-0.5">⚠️</span>
                            <p>Al ritmo actual, te quedarás sin stock antes del próximo <b>[Día Peak]</b>.</p>
                        </div>
                    </div>
                </div>

                <!-- Plan de Acción Táctico -->
                <div class="bg-indigo-50 p-6 rounded-2xl border border-indigo-100">
                    <h3 class="text-indigo-900 font-bold flex items-center gap-2 mb-3">
                        <span>📅</span> Estrategia de Compra Sugerida
                    </h3>
                    <ul class="space-y-3">
                        <li class="flex gap-3 items-start text-sm text-slate-700">
                            <span class="text-green-500 font-bold">✓</span>
                            <span>
                                Para cubrir la demanda del <b>[Día Peak]</b>, realiza tu pedido de reabastecimiento el <b>[Día Sugerido = Peak - 2 días]</b>.
                            </span>
                        </li>
                        <li class="flex gap-3 items-start text-sm text-slate-700">
                            <span class="text-blue-500 font-bold">✓</span>
                            <span>
                                <i>Evita pérdidas:</i> No compres stock excesivo de productos lentos para días valle (como el [Día más lento]).
                            </span>
                        </li>
                    </ul>
                </div>
            </div>

            **IMPORTANTE FINAL:**
            NO agregues ninguna nota, explicación, ni texto como "Aquí está el código" o "**Explicación**" al final. 
            Tu respuesta debe comenzar con <div y terminar con </div>. NADA MÁS.
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        // --- LIMPIEZA QUIRÚRGICA ---
        let cleanHtml = text.replace(/```html/g, '').replace(/```/g, '');
        
        const lastDivIndex = cleanHtml.lastIndexOf('</div>');
        if (lastDivIndex !== -1) {
            cleanHtml = cleanHtml.substring(0, lastDivIndex + 6);
        }

        res.json({ html: cleanHtml });

    } catch (error) {
        console.error('Error con Gemini:', error.message);
        res.status(500).json({ error: 'La IA está procesando demasiados datos. Intenta de nuevo.' });
    }
});

// --- ENDPOINT: CREAR TRANSACCIÓN WEBPAY ---
app.post('/crear-transaccion', async (req, res) => {
  try {
    const { monto, plan, userId } = req.body;
    if (!monto || !plan || !userId) {
      return res.status(400).json({ error: 'Monto, plan y userId son requeridos' });
    }
    const buyOrder = 'ORD-' + Date.now();
    const sessionId = 'SES-' + Date.now();
    const returnUrl = 'http://localhost:3000/retorno'; 

    tempTransactionStorage[sessionId] = { plan, monto, userId };

    const tx = createTx();
    const response = await tx.create(buyOrder, sessionId, monto, returnUrl);

    res.json({ url: response.url, token: response.token });
  } catch (error) {
    console.error('Error creando transacción:', error);
    res.status(500).json({ error: 'Error creando transacción', details: String(error) });
  }
});

// --- ENDPOINT: RETORNO WEBPAY ---
app.get('/retorno', async (req, res) => {
  try {
    const { token_ws, TBK_TOKEN } = req.query;

    if (TBK_TOKEN) {
      return res.redirect(`/retorno.html?status=cancelled`);
    }

    if (token_ws) {
      const tx = createTx();
      const result = await tx.commit(token_ws);
      
      const { plan, userId } = tempTransactionStorage[result.session_id] || { plan: 'Desconocido', userId: null };
      delete tempTransactionStorage[result.session_id];

      if (result.status === 'AUTHORIZED') {
        if (userId) {
          try {
            const userDocRef = db.collection('users').doc(userId);
            await userDocRef.update({
              plan: plan,
              planStartDate: new Date().toISOString(),
              subscriptionStatus: 'active',
              // Opcional: Forzar limpieza si cambia de plan (descomentar si se requiere)
              // dataCollectionPath: (plan === 'gratis') ? null : userDocRef.data()?.dataCollectionPath 
            });
          } catch (dbError) {
            console.error('Error Firebase:', dbError);
          }
        }
        const params = new URLSearchParams({
          status: 'success',
          amount: result.amount,
          plan: plan,
          card: result.card_detail.card_number,
          date: result.transaction_date
        });
        return res.redirect(`/retorno.html?${params.toString()}`);
      } else {
        return res.redirect(`/retorno.html?status=rejected`);
      }
    }
    res.redirect('/retorno.html?status=invalid');
  } catch (error) {
    res.redirect('/retorno.html?status=error');
  }
});

app.listen(3000, () => {
  console.log("Servidor funcionando en http://localhost:3000");
  console.log("Prueba los planes en http://localhost:3000/ejemplo.html");
});