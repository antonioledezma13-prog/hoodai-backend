const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const auth      = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const Vehicle   = require('../models/Vehicle');
const Scan      = require('../models/Scan');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.post('/', auth, checkUsos, async (req, res) => {
  try {
    const { message, vehicleId, scanId, history = [], lang = 'es' } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const role = req.user.role || 'usuario';
    let contextLines = [];

    if (vehicleId) {
      const v = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id });
      if (v) contextLines.push(`Vehículo del usuario: ${v.year} ${v.make} ${v.model}${v.engine ? ` motor ${v.engine}` : ''}.`);
    }

    if (scanId) {
      const scan = await Scan.findOne({ _id: scanId, userId: req.user._id });
      if (scan?.parts?.length) {
        const partsSummary = scan.parts.map(p => `${p.name} (${p.status})`).join(', ');
        contextLines.push(`Último escaneo detectó: ${partsSummary}. Resumen: ${scan.summary}`);
      }
    }

    const roleContext = {
      usuario:   'El usuario es un conductor normal que necesita orientación mecánica clara y sencilla.',
      taller:    'El usuario es un taller mecánico. Puede usar lenguaje técnico. Ayúdalo con diagnósticos avanzados, presupuestos y gestión de clientes.',
      grua:      'El usuario opera un servicio de grúas. Ayúdalo con logística, rutas de asistencia y protocolos de rescate vehicular.',
      repuestos: 'El usuario es una tienda de repuestos. Ayúdalo con compatibilidad de piezas, inventario y proveedores.',
    };

    const systemPrompt = `Eres Hoodai — Tu aliado en asesorías y emergencias mecánicas.
${roleContext[role] || roleContext.usuario}
${contextLines.join(' ')}
Tono: ejecutivo, calmado, pedagógico. Respuestas concisas. Usa analogías de la vida diaria para usuarios normales.`;

    const messages = [
      ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message },
    ];

    const response = await client.messages.create({
      model:      'claude-opus-4-6',
      max_tokens: 512,
      system:     systemPrompt,
      messages,
    });

    await req.user.consumirUso();
    res.json({ reply: response.content[0].text, usosRestantes: req.user.usosRestantes + req.user.usosExtra });

  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
