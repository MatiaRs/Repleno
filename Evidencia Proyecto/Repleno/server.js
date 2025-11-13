// server.js
import express from 'express';
import pkg from 'transbank-sdk';
import cors from 'cors';

const { WebpayPlus, IntegrationCommerceCodes, IntegrationApiKeys, Environment, Options } = pkg;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const commerceCode = IntegrationCommerceCodes.WEBPAY_PLUS; 
const apiKey = IntegrationApiKeys.WEBPAY;                  
const environment = Environment.Integration;               

function createTx() {
  return new WebpayPlus.Transaction(new Options(commerceCode, apiKey, environment));
}
app.post('/crear-transaccion', async (req, res) => {
  try {
    const { monto } = req.body;
    const buyOrder = 'ORD-' + Date.now();
    const sessionId = 'SES-' + Date.now();
    const returnUrl = 'http://localhost:3000/retorno'; 

    const tx = createTx();
    const response = await tx.create(buyOrder, sessionId, monto, returnUrl);

    res.json({ url: response.url, token: response.token, buyOrder, sessionId, amount: monto });
  } catch (error) {
    console.error('Error creando transacción:', error);
    res.status(500).json({ error: 'Error creando transacción', details: String(error) });
  }
});

app.post('/retorno', async (req, res) => {
  try {
    const { token_ws } = req.body;
    const tx = createTx();
    const result = await tx.commit(token_ws);

    res.send(`
      <h2>Resultado del pago</h2>
      <pre>${JSON.stringify(result, null, 2)}</pre>
      <p><a href="/">Volver</a></p>
    `);
  } catch (error) {
    console.error('Error procesando retorno:', error);
    res.status(500).send('Error procesando retorno');
  }
});
app.listen(3000, () => {
  console.log("funciona :D");
});

