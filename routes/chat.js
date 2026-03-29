const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const auth      = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const Vehicle   = require('../models/Vehicle');
const Scan      = require('../models/Scan');
const User      = require('../models/User');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Palabras clave que indican emergencia / necesidad de grúa
const GRUA_KEYWORDS = [
  'grúa','grua','remolque','remolcar','jalón','jalón','jalar','arrastrar',
  'varado','varada','no arranca','no enciende','accidente','choque',
  'volcado','volcó','quedé tirado','quedé en la calle','emergencia',
  'auxilio','ayuda urgente','auxilio mecánico',
];

function needsGrua(text) {
  const lower = text.toLowerCase();
  return GRUA_KEYWORDS.some(kw => lower.includes(kw));
}

// POST /api/chat
router.post('/', auth, checkUsos, async (req, res) => {
  try {
    const { message, vehicleId, scanId, history = [], lang = 'es' } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const role = req.user.role || 'usuario';
    let contextLines = [];

    if (vehicleId) {
      const v = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id });
      if (v) contextLines.push(`Vehículo del usuario: ${v.year} ${v.make} ${v.model}${v.engine ? ` motor ${v.engine}` : ''}${v.placa ? ` placa ${v.placa}` : ''}.`);
    }

    if (scanId) {
      const scan = await Scan.findOne({ _id: scanId, userId: req.user._id });
      if (scan?.parts?.length) {
        const partsSummary = scan.parts.map(p => `${p.name} (${p.status})`).join(', ');
        contextLines.push(`Último escaneo detectó: ${partsSummary}. Resumen: ${scan.summary}`);
      }
    }

    // Consultar grúas disponibles para enriquecer el contexto del asesor
    const gruasDisponibles = await User.find({ role: 'grua', disponible: true })
      .select('name businessName phone address coverageZone')
      .lean();

    let gruaContext = '';
    if (gruasDisponibles.length > 0) {
      const lista = gruasDisponibles.map((g, i) =>
        `${i+1}. ${g.businessName || g.name} | Tel: ${g.phone || 'N/D'} | Zona: ${g.coverageZone || g.address || 'N/D'}`
      ).join('\n');
      gruaContext = `\n\nGRÚAS DISPONIBLES EN HOODAI AHORA MISMO:\n${lista}\nSi el usuario necesita grúa, menciónale que puede solicitar una con el botón de servicio de grúa y se le asignará la más cercana.`;
    } else {
      gruaContext = `\n\nActualmente no hay grúas HoodAI disponibles en línea. Si el usuario necesita grúa, indícale que puede contactar servicios externos mientras tanto.`;
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
${gruaContext}
Tono: ejecutivo, calmado, pedagógico. Respuestas concisas. Usa analogías de la vida diaria para usuarios normales.
Cuando detectes que el usuario necesita grúa o está en emergencia, responde con empatía e indícale que puede usar el botón "🚛 Solicitar Grúa" que aparece en la app.`;

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

    const reply = response.content[0].text;

    // Detectar si el mensaje o la respuesta sugieren necesidad de grúa
    const sugierGrua = needsGrua(message) || needsGrua(reply);

    await req.user.consumirUso();
    res.json({
      reply,
      sugierGrua,
      gruasDisponibles: gruasDisponibles.length,
      usosRestantes: req.user.usosRestantes + req.user.usosExtra,
    });

  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/chat/solicitar-grua — asigna grúa más cercana al usuario
router.post('/solicitar-grua', auth, async (req, res) => {
  try {
    const { lat, lon, vehicleId } = req.body;

    const gruas = await User.find({ role: 'grua', disponible: true })
      .select('name businessName phone address coverageZone')
      .lean();

    if (!gruas.length)
      return res.status(404).json({ error: 'No hay grúas disponibles en este momento.' });

    // Si hay coordenadas GPS, usar IA para recomendar la más cercana/apropiada
    // Si no, devolver la primera disponible
    let gruaAsignada = gruas[0];

    if (lat && lon && gruas.length > 1) {
      const lista = gruas.map((g, i) =>
        `${i}: ${g.businessName || g.name}, zona: ${g.coverageZone || g.address || 'no especificada'}, tel: ${g.phone}`
      ).join('\n');

      const prompt = `El usuario está en coordenadas lat:${lat}, lon:${lon} (${req.body.ciudadRef || 'Venezuela'}).
Grúas disponibles:\n${lista}\n
Responde SOLO con el número índice (0, 1, 2...) de la grúa más apropiada para esta ubicación. Sin texto adicional.`;

      const aiRes = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 5,
        messages: [{ role: 'user', content: prompt }],
      });

      const idx = parseInt(aiRes.content[0].text.trim());
      if (!isNaN(idx) && gruas[idx]) gruaAsignada = gruas[idx];
    }

    let vehicleInfo = null;
    if (vehicleId) {
      vehicleInfo = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id })
        .select('make model year placa').lean();
    }

    res.json({
      grua: {
        nombre:   gruaAsignada.businessName || gruaAsignada.name,
        telefono: gruaAsignada.phone        || 'No disponible',
        zona:     gruaAsignada.coverageZone || gruaAsignada.address || 'No especificada',
      },
      usuario: {
        nombre:  req.user.name,
        telefono: req.user.phone || '',
      },
      vehiculo: vehicleInfo,
      coordenadas: lat && lon ? { lat, lon } : null,
      mensaje: `🚛 Grúa asignada: ${gruaAsignada.businessName || gruaAsignada.name}. Contáctala al ${gruaAsignada.phone || 'número no registrado'}.`,
    });

  } catch (e) {
    console.error('Solicitar grua error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;


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
