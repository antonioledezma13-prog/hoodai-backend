const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const auth      = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const Peritaje  = require('../models/Peritaje');
const Vehicle   = require('../models/Vehicle');
const User      = require('../models/User');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /api/seguro/peritaje — conductor inicia peritaje digital
router.post('/peritaje', auth, checkUsos, async (req, res) => {
  try {
    const { imagenesBase64, vehicleId, descripcionAccidente } = req.body;
    if (!imagenesBase64 || !imagenesBase64.length)
      return res.status(400).json({ error: 'Se requieren imágenes del accidente' });

    let vehicleContext = '';
    let vehicle = null;
    if (vehicleId) {
      vehicle = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id });
      if (vehicle) vehicleContext = `Vehículo: ${vehicle.year} ${vehicle.make} ${vehicle.model}`;
    }

    const systemPrompt = `Eres el sistema de peritaje digital de HoodAI para aseguradoras.
Analiza las imágenes de un accidente vehicular y genera un reporte técnico detallado.
${vehicleContext}
Descripción del accidente: "${descripcionAccidente || 'No especificada'}"

GENERA UN REPORTE DE PERITAJE en este JSON exacto (sin markdown):
{
  "danos": [
    { "parte": "Nombre de la parte", "gravedad": "LEVE|MODERADO|GRAVE", "descripcion": "Descripción del daño", "costoEstimado": "$XX–$XX USD" }
  ],
  "gravedad": "LEVE|MODERADO|GRAVE|TOTAL",
  "resumenDanos": "Resumen ejecutivo del accidente y daños en 2-3 oraciones",
  "costoTotal": "$XXX–$XXX USD",
  "recomendacion": "Reparable|Pérdida total",
  "observaciones": "Notas importantes para la aseguradora"
}`;

    // Usar primera imagen para análisis
    const base64Data = imagenesBase64[0].replace(/^data:image\/\w+;base64,/, '');

    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64Data },
        }, {
          type: 'text',
          text: 'Analiza este accidente vehicular y genera el reporte de peritaje.',
        }],
      }],
    });

    const raw = message.content[0].text.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      parsed = { danos: [], resumenDanos: raw, gravedad: 'MODERADO', costoTotal: 'N/A' };
    }

    const peritaje = await Peritaje.create({
      userId:        req.user._id,
      vehicleId:     vehicle?._id,
      imagenes:      imagenesBase64.map(i => i.slice(0, 200)),
      danos:         parsed.danos || [],
      resumenDanos:  parsed.resumenDanos || '',
      gravedad:      parsed.gravedad || 'MODERADO',
      costoTotal:    parsed.costoTotal || '',
      rawResponse:   raw,
    });

    await req.user.consumirUso();
    res.json({ peritajeId: peritaje._id, ...parsed, usosRestantes: req.user.usosRestantes + req.user.usosExtra });

  } catch (e) {
    console.error('Peritaje error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/seguro/peritajes — aseguradora ve peritajes pendientes
router.get('/peritajes', auth, async (req, res) => {
  try {
    if (req.user.role !== 'seguro')
      return res.status(403).json({ error: 'Solo aseguradoras' });
    const peritajes = await Peritaje.find({ estado: 'pendiente' })
      .populate('userId', 'name email phone')
      .populate('vehicleId', 'make model year')
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(peritajes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/seguro/mis-peritajes — conductor ve sus peritajes
router.get('/mis-peritajes', auth, async (req, res) => {
  try {
    const peritajes = await Peritaje.find({ userId: req.user._id })
      .populate('vehicleId', 'make model year')
      .sort({ createdAt: -1 });
    res.json(peritajes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/seguro/peritaje/:id — aseguradora actualiza estado
router.put('/peritaje/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'seguro')
      return res.status(403).json({ error: 'Solo aseguradoras' });
    const { estado, observaciones } = req.body;
    const peritaje = await Peritaje.findByIdAndUpdate(
      req.params.id,
      { estado, observaciones, aseguradoraId: req.user._id },
      { new: true }
    );
    res.json(peritaje);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
