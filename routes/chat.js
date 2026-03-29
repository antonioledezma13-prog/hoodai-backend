const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const auth      = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const Vehicle   = require('../models/Vehicle');
const Scan      = require('../models/Scan');
const User      = require('../models/User');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Detección de keywords ──────────────────────────────────────────────────

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

function needsGrua(text)   { const l = text.toLowerCase(); return GRUA_KEYWORDS.some(k => l.includes(k)); }
function needsTaller(text) { const l = text.toLowerCase(); return TALLER_KEYWORDS.some(k => l.includes(k)); }

// ── POST /api/chat ─────────────────────────────────────────────────────────

router.post('/', auth, checkUsos, async (req, res) => {
  try {
    const { message, vehicleId, scanId, history = [], lang = 'es' } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const role = req.user.role || 'usuario';
    let contextLines = [];

    // Contexto del vehículo
    let vehicleMake = '';
    if (vehicleId) {
      const v = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id });
      if (v) {
        vehicleMake = v.make;
        contextLines.push(
          `Vehículo del usuario: ${v.year} ${v.make} ${v.model}` +
          `${v.engine ? ` motor ${v.engine}` : ''}` +
          `${v.placa  ? ` placa ${v.placa}`  : ''}.`
        );
      }
    }

    // Contexto del escaneo
    if (scanId) {
      const scan = await Scan.findOne({ _id: scanId, userId: req.user._id });
      if (scan?.parts?.length) {
        const partsSummary = scan.parts.map(p => `${p.name} (${p.status})`).join(', ');
        contextLines.push(`Último escaneo detectó: ${partsSummary}. Resumen: ${scan.summary}`);
      }
    }

    // ── Grúas disponibles ──
    const gruasDisponibles = await User.find({ role: 'grua', disponible: true })
      .select('name businessName phone address coverageZone').lean();

    let gruaContext = gruasDisponibles.length > 0
      ? `\n\nGRÚAS DISPONIBLES EN HOODAI AHORA MISMO:\n` +
        gruasDisponibles.map((g, i) =>
          `${i+1}. ${g.businessName || g.name} | Tel: ${g.phone || 'N/D'} | Zona: ${g.coverageZone || g.address || 'N/D'}`
        ).join('\n') +
        `\nSi el usuario necesita grúa, menciónale que puede solicitar una con el botón de servicio de grúa.`
      : `\n\nNo hay grúas HoodAI disponibles ahora. Si necesita grúa, sugiere contactar servicios externos.`;

    // ── Talleres registrados ──
    const talleresRegistrados = await User.find({ role: 'taller' })
      .select('name businessName phone address coverageZone specialties').lean();

    let tallerContext = talleresRegistrados.length > 0
      ? `\n\nTALLERES REGISTRADOS EN HOODAI:\n` +
        talleresRegistrados.map((t, i) =>
          `${i+1}. ${t.businessName || t.name} | Tel: ${t.phone || 'N/D'} | Zona: ${t.coverageZone || t.address || 'N/D'}` +
          (t.specialties?.length ? ` | Especialidades: ${t.specialties.join(', ')}` : '')
        ).join('\n') +
        `\nSi el usuario necesita un taller, menciónale que puede buscar el más cercano especializado en su marca con el botón de búsqueda de taller.`
      : `\n\nNo hay talleres HoodAI registrados aún. Si necesita taller, sugiere buscar localmente.`;

    const roleContext = {
      usuario:   'El usuario es un conductor normal que necesita orientación mecánica clara y sencilla.',
      taller:    'El usuario es un taller mecánico. Puede usar lenguaje técnico. Ayúdalo con diagnósticos avanzados, presupuestos y gestión de clientes.',
      grua:      'El usuario opera un servicio de grúas. Ayúdalo con logística, rutas de asistencia y protocolos de rescate vehicular.',
      repuestos: 'El usuario es una tienda de repuestos. Ayúdalo con compatibilidad de piezas, inventario y proveedores.',
    };

    const systemPrompt =
      `Eres Hoodai — Tu aliado en asesorías y emergencias mecánicas.\n` +
      `${roleContext[role] || roleContext.usuario}\n` +
      `${contextLines.join(' ')}\n` +
      gruaContext +
      tallerContext +
      `\nTono: ejecutivo, calmado, pedagógico. Respuestas concisas.\n` +
      `Cuando detectes que el usuario necesita grúa, indícale que use el botón "🚛 Solicitar Grúa".\n` +
      `Cuando detectes que el usuario necesita un taller, pregúntale por su zona o deja que use el botón "🔧 Buscar Taller" para encontrar el más cercano especializado en su marca.`;

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

    const sugierGrua   = needsGrua(message)   || needsGrua(reply);
    const sugierTaller = needsTaller(message)  || needsTaller(reply);

    await req.user.consumirUso();
    res.json({
      reply,
      sugierGrua,
      sugierTaller,
      gruasDisponibles:   gruasDisponibles.length,
      talleresDisponibles: talleresRegistrados.length,
      usosRestantes: req.user.usosRestantes + req.user.usosExtra,
    });

  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/chat/solicitar-grua ──────────────────────────────────────────

router.post('/solicitar-grua', auth, async (req, res) => {
  try {
    const { lat, lon, vehicleId } = req.body;

    const gruas = await User.find({ role: 'grua', disponible: true })
      .select('name businessName phone address coverageZone').lean();

    if (!gruas.length)
      return res.status(404).json({ error: 'No hay grúas disponibles en este momento.' });

    let gruaAsignada = gruas[0];

    if (lat && lon && gruas.length > 1) {
      const lista = gruas.map((g, i) =>
        `${i}: ${g.businessName || g.name}, zona: ${g.coverageZone || g.address || 'no especificada'}`
      ).join('\n');
      const aiRes = await client.messages.create({
        model: 'claude-opus-4-6', max_tokens: 5,
        messages: [{ role: 'user', content:
          `Usuario en lat:${lat}, lon:${lon}.\nGrúas:\n${lista}\nResponde SOLO el número índice de la más apropiada.`
        }],
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
      vehiculo:    vehicleInfo,
      coordenadas: lat && lon ? { lat, lon } : null,
      mensaje: `🚛 Grúa asignada: ${gruaAsignada.businessName || gruaAsignada.name}. Contáctala al ${gruaAsignada.phone || 'número no registrado'}.`,
    });

  } catch (e) {
    console.error('Solicitar grua error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/chat/buscar-taller ───────────────────────────────────────────

router.post('/buscar-taller', auth, async (req, res) => {
  try {
    const { lat, lon, vehicleId, marcaBuscada } = req.body;

    // Obtener marca del vehículo si no viene explícita
    let marca = marcaBuscada || '';
    if (!marca && vehicleId) {
      const v = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id }).lean();
      if (v) marca = v.make;
    }

    // Buscar talleres — priorizar los que tienen la marca en specialties
    const todosTalleres = await User.find({ role: 'taller' })
      .select('name businessName phone address coverageZone specialties').lean();

    if (!todosTalleres.length)
      return res.status(404).json({ error: 'No hay talleres HoodAI registrados aún.' });

    // Separar especializados en la marca vs generales
    const especializados = marca
      ? todosTalleres.filter(t =>
          t.specialties?.some(s => s.toLowerCase().includes(marca.toLowerCase()))
        )
      : [];
    const candidatos = especializados.length > 0 ? especializados : todosTalleres;

    let tallerAsignado = candidatos[0];

    // Si hay GPS y más de un candidato, usar IA para elegir el más cercano
    if (lat && lon && candidatos.length > 1) {
      const lista = candidatos.map((t, i) =>
        `${i}: ${t.businessName || t.name}, zona: ${t.coverageZone || t.address || 'no especificada'}` +
        (t.specialties?.length ? `, especialidades: ${t.specialties.join(', ')}` : '')
      ).join('\n');

      const aiRes = await client.messages.create({
        model: 'claude-opus-4-6', max_tokens: 5,
        messages: [{ role: 'user', content:
          `Usuario en lat:${lat}, lon:${lon}. Busca taller para marca: "${marca || 'cualquiera'}".\nTalleres:\n${lista}\nResponde SOLO el número índice del más apropiado.`
        }],
      });
      const idx = parseInt(aiRes.content[0].text.trim());
      if (!isNaN(idx) && candidatos[idx]) tallerAsignado = candidatos[idx];
    }

    res.json({
      taller: {
        nombre:          tallerAsignado.businessName || tallerAsignado.name,
        telefono:        tallerAsignado.phone        || 'No disponible',
        zona:            tallerAsignado.coverageZone || tallerAsignado.address || 'No especificada',
        especialidades:  tallerAsignado.specialties  || [],
      },
      marca,
      esEspecializado: especializados.length > 0,
      coordenadas: lat && lon ? { lat, lon } : null,
      mensaje: `🔧 Taller encontrado: ${tallerAsignado.businessName || tallerAsignado.name}. Contáctalo al ${tallerAsignado.phone || 'número no registrado'}.`,
    });

  } catch (e) {
    console.error('Buscar taller error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
