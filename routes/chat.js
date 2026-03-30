const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const auth      = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const Vehicle   = require('../models/Vehicle');
const Scan      = require('../models/Scan');
const User      = require('../models/User');
const Repuesto  = require('../models/Repuesto');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL_NAME = "claude-3-5-sonnet-latest";

const GRUA_KEYWORDS = ['grúa','grua','remolque','remolcar','jalón','jalar','arrastrar','varado','no arranca','emergencia','auxilio'];
const TALLER_KEYWORDS = ['taller','mecánico','mecanico','reparar','reparación','arreglar','falla','revisión','diagnóstico','mantenimiento'];
const REPUESTO_KEYWORDS = ['repuesto','pieza','parte','correa','filtro','bujía','alternador','batería','bomba','radiador','sensor'];

function needsGrua(text) { return GRUA_KEYWORDS.some(k => text.toLowerCase().includes(k)); }
function needsTaller(text) { return TALLER_KEYWORDS.some(k => text.toLowerCase().includes(k)); }
function needsRepuesto(text) { return REPUESTO_KEYWORDS.some(k => text.toLowerCase().includes(k)); }

async function extractPieza(message) {
  try {
    const prompt = "Extrae solo el nombre de la pieza de este mensaje: " + message + ". Si no hay, responde repuesto.";
    const r = await client.messages.create({
      model: MODEL_NAME,
      max_tokens: 20,
      messages: [{ role: 'user', content: prompt }]
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

    let contextLines = [];
    if (vehicleId) {
      const v = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id });
      if (v) contextLines.push("Vehículo: " + v.year + " " + v.make + " " + v.model);
    }

    const systemPrompt = "Eres Hoodai. Asistente mecánico profesional. Responde siempre en texto plano. Prohibido usar negritas, cursivas, guiones o viñetas. Sin Markdown.";

    const response = await client.messages.create({
      model: MODEL_NAME,
      max_tokens: 512,
      system: systemPrompt,
      messages: [
        ...history.slice(-5).map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message }
      ]
    });

    let reply = response.content[0].text;
    reply = reply.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^- /gm, '').replace(/#/g, '');

    const sugierGrua = needsGrua(message) || needsGrua(reply);
    const sugierTaller = needsTaller(message) || needsTaller(reply);
    const sugierRepuesto = needsRepuesto(message) || needsRepuesto(reply);

    if (req.user.consumirUso) await req.user.consumirUso();

    res.json({
      reply,
      sugierGrua,
      sugierTaller,
      sugierRepuesto,
      usosRestantes: (req.user.usosRestantes  0) + (req.user.usosExtra  0)
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/solicitar-grua', auth, async (req, res) => {
  try {
    const gruas = await User.find({ role: 'grua', disponible: true }).limit(1);
    if (!gruas.length) return res.status(404).json({ error: 'No hay grúas' });
    res.json({ grua: { nombre: gruas[0].businessName || gruas[0].name, telefono: gruas[0].phone } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/buscar-taller', auth, async (req, res) => {
  try {
    const talleres = await User.find({ role: 'taller' }).limit(1);
    res.json({ taller: { nombre: talleres[0].businessName || talleres[0].name, telefono: talleres[0].phone } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/buscar-repuesto', auth, async (req, res) => {
  try {
    const { piezaTexto } = req.body;
    const pieza = await extractPieza(piezaTexto || '');
    const tiendas = await User.find({ role: 'repuestos' }).limit(1);
    res.json({ tienda: { nombre: tiendas[0]?.businessName || tiendas[0]?.name, telefono: tiendas[0]?.phone }, pieza });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;