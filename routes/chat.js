const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const auth      = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const Vehicle   = require('../models/Vehicle');
const Scan      = require('../models/Scan');
const User      = require('../models/User');
const Repuesto  = require('../models/Repuesto');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Modelo oficial estable para evitar el error 404
const MODEL_NAME = "claude-3-opus-20240229";

// Detección de keywords
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
      model: MODEL_NAME, 
      max_tokens: 20,
      messages: [{ role: 'user', content: "Extrae solo el nombre del repuesto de: " + message }],
    });
    return r.content[0].text.trim().toLowerCase();
  } catch (e) {
    return 'repuesto';
  }
}

// POST /api/chat
router.post('/', auth, checkUsos, async (req, res) => {
  try {
    const { message, vehicleId, scanId, history = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    let contextLines = [];
    if (vehicleId) {
      const v = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id });
      if (v) contextLines.push("Vehiculo: " + v.year + " " + v.make + " " + v.model);
    }

    const systemPrompt = 
      "Eres Hoodai. Asistente mecanico profesional. " +
      "Responde siempre en texto plano. Prohibido usar negritas, cursivas, guiones o viñetas. Sin Markdown. " +
      "Contexto: " + contextLines.join(' ');

    const response = await client.messages.create({
      model: MODEL_NAME, 
      max_tokens: 512,
      system: systemPrompt,
      messages: [
        ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message }
      ],
    });

    let reply = response.content[0].text;
    // Limpieza estricta de Markdown
    reply = reply.replace(/\*\*|\*|__/g, '').replace(/^- /gm, '').replace(/^#+ /gm, '');

    const sugierGrua     = needsGrua(message)     || needsGrua(reply);
    const sugierTaller   = needsTaller(message)    || needsTaller(reply);
    const sugierRepuesto = needsRepuesto(message)  || needsRepuesto(reply);

    if (req.user.consumirUso) await req.user.consumirUso();

    const restantes = req.user.usosRestantes || 0;
    const extras = req.user.usosExtra || 0;

    res.json({
      reply, 
      sugierGrua, 
      sugierTaller, 
      sugierRepuesto,
      usosRestantes: restantes + extras,
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/chat/solicitar-grua
router.post('/solicitar-grua', auth, async (req, res) => {
  try {
    const gruas = await User.find({ role: 'grua', disponible: true }).limit(1);
    if (!gruas.length) return res.status(404).json({ error: 'No hay gruas disponibles.' });
    res.json({
      grua: { nombre: gruas[0].businessName || gruas[0].name, telefono: gruas[0].phone },
      mensaje: "Grua asignada: " + (gruas[0].businessName || gruas[0].name),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/chat/buscar-taller
router.post('/buscar-taller', auth, async (req, res) => {
  try {
    const talleres = await User.find({ role: 'taller' }).limit(1);
    if (!talleres.length) return res.status(404).json({ error: 'No hay talleres.' });
    res.json({
      taller: { nombre: talleres[0].businessName || talleres[0].name, telefono: talleres[0].phone },
      mensaje: "Taller encontrado: " + (talleres[0].businessName || talleres[0].name),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/chat/buscar-repuesto
router.post('/buscar-repuesto', auth, async (req, res) => {
  try {
    const { piezaTexto } = req.body;
    const pieza = await extractPieza(piezaTexto || '');
    const tiendas = await User.find({ role: 'repuestos' }).limit(1);
    res.json({
      tienda: { nombre: tiendas[0]?.businessName || tiendas[0]?.name, telefono: tiendas[0]?.phone },
      pieza,
      mensaje: "Consulta disponibilidad de " + pieza + " en tienda.",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;