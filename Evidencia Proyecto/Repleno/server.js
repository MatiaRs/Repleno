import express from 'express';
import pkg from 'transbank-sdk';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

// --- NUEVO: IMPORTAR FIREBASE ADMIN ---
import admin from 'firebase-admin';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// --- NUEVO: Importar 'fs' para leer el JSON ---
import { readFileSync } from 'fs';

const { WebpayPlus, IntegrationCommerceCodes, IntegrationApiKeys, Environment, Options } = pkg;

// --- MOVIDO Y MODIFICADO: Definir __dirname y leer el JSON ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
// --- FIN DE LA LECTURA DEL JSON ---

// --- NUEVO: INICIALIZAR FIREBASE ---
try {
  initializeApp({
    credential: cert(serviceAccount)
  });
} catch (error) {
  if (!/already exists/.test(error.message)) {
    console.error('Error inicializando Firebase Admin:', error);
  }
}

const db = getFirestore();
// --- FIN BLOQUE FIREBASE ---

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname)));

const commerceCode = IntegrationCommerceCodes.WEBPAY_PLUS;
const apiKey = IntegrationApiKeys.WEBPAY;
const environment = Environment.Integration;

const tempTransactionStorage = {};

function createTx() {
  return new WebpayPlus.Transaction(new Options(commerceCode, apiKey, environment));
}

app.post('/crear-transaccion', async (req, res) => {
  try {
    // --- MODIFICADO: Aceptar 'userId' ---
    const { monto, plan, userId } = req.body;
    if (!monto || !plan || !userId) {
      return res.status(400).json({ error: 'Monto, plan y userId son requeridos' });
    }
    const buyOrder = 'ORD-' + Date.now();
    const sessionId = 'SES-' + Date.now();
    
    // Usamos la URL de tu máquina local
    const returnUrl = 'http://localhost:3000/retorno'; 

    // --- MODIFICADO: Guardar 'userId' en la sesión temporal ---
    tempTransactionStorage[sessionId] = { plan, monto, userId };

    const tx = createTx();
    const response = await tx.create(buyOrder, sessionId, monto, returnUrl);

    res.json({ url: response.url, token: response.token });
  } catch (error) {
    console.error('Error creando transacción:', error);
    res.status(500).json({ error: 'Error creando transacción', details: String(error) });
  }
});

app.get('/retorno', async (req, res) => {
  try {
    const { token_ws, TBK_TOKEN } = req.query;

    if (TBK_TOKEN) {
      console.log('Pago cancelado por el usuario.');
      return res.redirect(`/retorno.html?status=cancelled`);
    }

    if (token_ws) {
      const tx = createTx();
      const result = await tx.commit(token_ws);
      
      console.log('Resultado completo del commit:', JSON.stringify(result, null, 2));

      // --- MODIFICADO: Obtener 'plan' y 'userId' de la sesión ---
      const { plan, userId } = tempTransactionStorage[result.session_id] || { plan: 'Desconocido', userId: null };
      delete tempTransactionStorage[result.session_id];

      if (result.status === 'AUTHORIZED') {
        
        // --- ¡NUEVO! ACTUALIZAR FIREBASE ---
        if (userId) {
          try {
            const userDocRef = db.collection('users').doc(userId);
            await userDocRef.update({
              plan: plan,
              planStartDate: new Date().toISOString(),
              subscriptionStatus: 'active'
            });
            console.log(`¡Usuario ${userId} actualizado al ${plan} exitosamente!`);
          } catch (dbError) {
            console.error('¡ERROR AL ACTUALIZAR FIREBASE!:', dbError);
            // El pago se realizó pero la BD falló. Esto requiere manejo manual.
            // Por ahora, solo lo registraremos y dejaremos que el usuario vea la página de éxito.
          }
        } else {
          console.error('¡ERROR! No se encontró userId para la sesión:', result.session_id);
        }
        // --- FIN BLOQUE NUEVO ---

        const params = new URLSearchParams({
          status: 'success',
          amount: result.amount,
          plan: plan,
          card: result.card_detail.card_number,
          date: result.transaction_date
        });
        return res.redirect(`/retorno.html?${params.toString()}`);

      } else {
        const params = new URLSearchParams({
          status: 'rejected',
          message: `Código de respuesta: ${result.response_code}`
        });
        return res.redirect(`/retorno.html?${params.toString()}`);
      }
    }

    res.redirect('/retorno.html?status=invalid');

  } catch (error) {
    console.error('Error procesando retorno:', error);
    res.redirect('/retorno.html?status=error');
  }
});

app.listen(3000, () => {
  console.log("Servidor funcionando en http://localhost:3000");
  console.log("Prueba los planes en http://localhost:3000/ejemplo.html");
});