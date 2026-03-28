const router     = require('express').Router();
const Anthropic  = require('@anthropic-ai/sdk');
const auth       = require('../middleware/auth');
const checkUsos  = require('../middleware/checkUsos');
const Vehicle    = require('../models/Vehicle');
const Scan       = require('../models/Scan');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// POST /api/analyze
// body: { imageBase64, vehicleId, symptoms, location, lang }
router.post('/', auth, checkUsos, async (req, res) => {
  try {
    const { imageBase64, vehicleId, symptoms = '', location = 'Venezuela', lang = 'es' } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    let vehicleContext = '';
    let vehicle = null;
    if (vehicleId) {
      vehicle = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id });
      if (vehicle) {
        vehicleContext = `PERFIL_VEHÍCULO: { marca: "${vehicle.make}", modelo: "${vehicle.model}", año: ${vehicle.year}${vehicle.engine ? `, motor: "${vehicle.engine}"` : ''} }`;
      }
    }

    const masterPrompt = `Eres el "Núcleo de Inteligencia 360" de HoodAI — Tu aliado en asesorías y emergencias mecánicas.
Tu función es actuar como experto mecánico pedagógico y director de logística automotriz, operando para usuarios en Venezuela y el mundo.

${vehicleContext}
SÍNTOMAS_USUARIO: "${symptoms || 'No especificados'}"
UBICACIÓN_USUARIO: "${location}"

FASE 1 — ANÁLISIS VISUAL Y ETIQUETADO:
Analiza la imagen del motor e identifica los componentes visibles.
Genera bounding boxes para: Batería, Alternador, Depósito de Refrigerante, Depósito Frenos, Filtro de Aire, Varilla de Aceite, Tapa de Aceite, Radiador, Correas.

FASE 2 — DIAGNÓSTICO Y GRAVEDAD:
Determina GRAVEDAD: BAJA (mantenimiento) / MEDIA (ir al taller) / CRÍTICA (no rodar).
Si es CRÍTICA, indica que se necesita grúa.
Identifica la falla probable y el repuesto necesario.

FASE 3 — RESPUESTA AMIGABLE Y PEDAGÓGICA:
Tono: ejecutivo, calmado, pedagógico. Evita términos como "OBD2", "torque", "relación de compresión".
Usa analogías de la vida diaria.
Si la imagen es de mala calidad, pide amablemente otra toma.

RESPONDE ÚNICAMENTE con este JSON (sin markdown, sin texto extra):
{
  "motor_info": { "tipo": "descripción", "cilindros": 0 },
  "gravedad": "BAJA|MEDIA|CRÍTICA",
  "etiquetas_visuales": [
    { "id": 1, "nombre": "Nombre pieza", "estado": "ok|warning|critical", "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 }
  ],
  "parts": [
    { "name": "Nombre", "status": "ok|warning|critical|unknown", "description": "Descripción amigable", "action": "Acción recomendada", "estimatedCost": "$XX–$XX USD", "confidence": 0.0 }
  ],
  "diagnostico_amigable": "Explicación pedagógica con analogía de la falla",
  "necesita_grua": false,
  "repuesto_necesario": "Nombre del repuesto o null",
  "summary": "Resumen general en 1-2 oraciones amigables"
}`;

    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1500,
      system: masterPrompt,
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64Data },
        }, {
          type: 'text',
          text: 'Analiza esta imagen del motor y responde con el JSON solicitado.',
        }],
      }],
    });

    const raw = message.content[0].text.trim();
    let parsed;
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      parsed = { parts: [], summary: raw, etiquetas_visuales: [] };
    }

    const scan = await Scan.create({
      userId:    req.user._id,
      vehicleId: vehicle?._id,
      thumbnail: base64Data.slice(0, 200),
      parts:     parsed.parts || [],
      summary:   parsed.summary || '',
      rawResponse: raw,
    });

    await req.user.consumirUso();
    res.json({ scanId: scan._id, usosRestantes: req.user.usosRestantes + req.user.usosExtra, ...parsed });

  } catch (e) {
    console.error('Analyze error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
