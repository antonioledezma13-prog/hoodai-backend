const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const auth      = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const Vehicle   = require('../models/Vehicle');
const Scan      = require('../models/Scan');
const User      = require('../models/User');
const Repuesto  = require('../models/Repuesto');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const GRUA_KEYWORDS = [
  'grúa','grua','remolque','remolcar','jalón','jalar','arrastrar',
  'varado','varada','no arranca','no enciende','accidente','choque',
  'volcado','volcó','quedé tirado','quedé en la calle','emergencia',
  'auxilio','ayuda urgente','auxilio mecánico',
];

const TALLER_KEYWORDS = [
  'taller','mecánico','mecanico','reparar','reparación','reparacion',
  'arreglar','falla','fallo','revisión','revision','servicio técnico',
  'diagnóstico','diagnostico','mantenimiento','cambio de aceite',
  'frenos','suspensión','transmisión','motor averiado','dónde reparo',
  'donde reparo','llévalo al taller','necesito taller',
];

const REPUESTO_KEYWORDS = [
  'repuesto','pieza','parte','correa','filtro','bujía','bujia','alternador',
  'batería','bateria','amortiguador','pastilla','disco de freno','bomba',
  'radiador','termostato','sensor','faro','retrovisor','espejo','llanta',
  'neumático','neumatico','banda','manguera','empaque','junta','rótula',
  'rotula','terminal','catalizador','escape','silenciador','carburador',
  'inyector','bobina','distribuidor','bomba de agua','compresor','correa de tiempo',
  'dónde consigo','donde consigo','dónde compro','donde compro','consigueme',
];

function needsGrua(text)    { const l = text.toLowerCase(); return GRUA_KEYWORDS.some(k => l.includes(k)); }
function needsTaller(text)  { const l = text.toLowerCase(); return TALLER_KEYWORDS.some(k => l.includes(k)); }
function needsRepuesto(text){ const l = text.toLowerCase(); return REPUESTO_KEYWORDS.some(k => l.includes(k)); }

async function extractPieza(message) {
  try {
    const r = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022', 
      max_tokens: 20,
      messages: [{ 
        role: 'user', 
        content: Del texto: "${message}"\nExtrae SOLO el nombre de la pieza automotriz mencionada. Si no hay, responde "repuesto". 
      }]
    });
    return r.content[0].text.trim().toLowerCase();
  } catch (e) {
    return 'repuesto';
  }
}

router.post('/', auth, checkUsos, async (req, res) => {
  try {
    const { message, vehicleId, scanId, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const role = req.user.role || 'usuario';
    let contextLines = [];
    let vehicleMake = '';

    if (vehicleId) {
      const v = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id });
      if (v) {
        vehicleMake = v.make;
        contextLines.push(Vehículo: ${v.year} ${v.make} ${v.model}.);
      }
    }

    if (scanId) {
      const scan = await Scan.findOne({ _id: scanId, userId: req.user._id });
      if (scan?.parts?.length) {
        contextLines.push(Escaneo: ${scan.summary});
      }
    }

    const systemPrompt =
      Eres Hoodai. Asistente mecánico profesional.\n +
      Contexto: ${contextLines.join(' ')}\n +
      Responde siempre en texto plano. Prohibido usar negritas, cursivas, guiones o viñetas. Sin Markdown.;

    const messages = [
      ...history.slice(-5).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const response = await client.messages.create({
      model: 'claude-3-5-sonnet-20241022', 
      max_tokens: 512,
      system: systemPrompt, 
      messages
    });

    let reply = response.content[0].text;
    reply = reply.replace(/\*\*|\*|__/g, '').replace(/^- /gm, '').replace(/^#+ /gm, '');
    const sugierGrua     = needsGrua(message)     || needsGrua(reply);
    const sugierTaller   = needsTaller(message)    || needsTaller(reply);
    const sugierRepuesto = needsRepuesto(message)  || needsRepuesto(reply);

    await req.user.consumirUso();
    res.json({
      reply, 
      sugierGrua, 
      sugierTaller, 
      sugierRepuesto,
      usosRestantes: req.user.usosRestantes + req.user.usosExtra
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/solicitar-grua', auth, async (req, res) => {
  try {
    const { lat, lon } = req.body;
    const gruas = await User.find({ role: 'grua', disponible: true }).limit(1);
    if (!gruas.length) return res.status(404).json({ error: 'No hay grúas disponibles.' });
    
    res.json({
      grua: { nombre: gruas[0].businessName || gruas[0].name, telefono: gruas[0].phone },
      mensaje: Grúa asignada: ${gruas[0].businessName || gruas[0].name}.
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/buscar-taller', auth, async (req, res) => {
  try {
    const talleres = await User.find({ role: 'taller' }).limit(1);
    res.json({
      taller: { nombre: talleres[0].businessName || talleres[0].name, telefono: talleres[0].phone },
      mensaje: Taller encontrado: ${talleres[0].businessName || talleres[0].name}.
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/buscar-repuesto', auth, async (req, res) => {
  try {
    const { piezaTexto } = req.body;
    const pieza = await extractPieza(piezaTexto);
    const tiendas = await User.find({ role: 'repuestos' }).limit(1);
    res.json({
      tienda: { nombre: tiendas[0].businessName || tiendas[0].name, telefono: tiendas[0].phone },
      pieza,
      mensaje: Consulta por ${pieza} en ${tiendas[0].businessName || tiendas[0].name}.
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;