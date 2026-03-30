const router = require('express').Router();
const auth   = require('../middleware/auth');
const User   = require('../models/User');
const { PLAN_PRICES, PLAN_PRICES_GOLD } = require('../models/User');

const PAYPAL_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API           = process.env.PAYPAL_ENV === 'production'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

async function getPayPalToken() {
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  return data.access_token;
}

// POST /api/pagos/crear-orden
router.post('/crear-orden', auth, async (req, res) => {
  try {
    const { tipo } = req.body; // 'silver' | 'gold' | 'extra'

    let precio, descripcion;
    if (tipo === 'extra') {
      precio      = 2;
      descripcion = '10 usos adicionales HoodAI';
    } else if (tipo === 'gold') {
      precio      = PLAN_PRICES_GOLD[req.user.role] || 30;
      descripcion = `Plan HoodAI ORO — 100 usos + Voz IA · ${req.user.role}`;
    } else {
      // silver (antes paid)
      precio      = PLAN_PRICES[req.user.role] || 6;
      descripcion = `Plan HoodAI SILVER — 25 usos · ${req.user.role}`;
    }

    const token    = await getPayPalToken();
    const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: 'USD', value: precio.toFixed(2) },
          description: descripcion,
        }],
        application_context: {
          return_url: process.env.FRONTEND_URL + '/pago-exitoso?tipo=' + tipo,
          cancel_url: process.env.FRONTEND_URL + '/pago-cancelado',
        },
      }),
    });

    const order = await orderRes.json();
    res.json({ orderId: order.id, tipo, precio });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/pagos/capturar
router.post('/capturar', auth, async (req, res) => {
  try {
    const { orderId, tipo } = req.body;

    const token      = await getPayPalToken();
    const captureRes = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    const capture = await captureRes.json();
    if (capture.status !== 'COMPLETED')
      return res.status(400).json({ error: 'Pago no completado' });

    if (tipo === 'extra') {
      await req.user.agregarUsosExtra(10, orderId);
      res.json({ ok: true, mensaje: '✅ 10 usos adicionales agregados', usosRestantes: req.user.usosRestantes + req.user.usosExtra });
    } else if (tipo === 'gold') {
      await req.user.activarPlanGold(orderId);
      res.json({ ok: true, mensaje: '🥇 Plan Oro activado — 100 usos + Voz IA', plan: 'gold', usosRestantes: 100 });
    } else {
      // silver
      await req.user.activarPlan(orderId);
      res.json({ ok: true, mensaje: '🥈 Plan Silver activado — 25 usos', plan: 'paid', usosRestantes: 25 });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/pagos/estado
router.get('/estado', auth, async (req, res) => {
  try {
    res.json({
      plan:          req.user.plan,
      usosRestantes: req.user.usosRestantes,
      usosExtra:     req.user.usosExtra,
      usosTotal:     req.user.usosRestantes + req.user.usosExtra,
      planExpira:    req.user.planExpira,
      precio:        PLAN_PRICES[req.user.role]     || 6,
      precioGold:    PLAN_PRICES_GOLD[req.user.role] || 30,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
