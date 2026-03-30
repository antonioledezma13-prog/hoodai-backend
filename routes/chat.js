const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const auth      = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const Vehicle   = require('../models/Vehicle');
const Scan      = require('../models/Scan');
const User      = require('../models/User');
const Repuesto  = require('../models/Repuesto');
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
// Extrae la pieza mencionada usando IA de forma ligera
async function extractPieza(message) {
  try {
    const r = await client.messages.create({
      model: 'claude-opus-4-6', max_tokens: 20,
      messages: [{ role: 'user', content:
      }],
    });
    return r.content[0].text.trim().toLowerCase();
  } catch {
    return 'repuesto';
  }
        Del texto: "${message}"\nExtrae SOLO el nombre de la pieza o repuesto automotriz mencionado (máx 4 palabras). Si no hay ninguno, responde "repuesto". Sin puntuación.}
// ── POST /api/chat ─────────────────────────────────────────────────────────
router.post('/', auth, checkUsos, async (req, res) => {
  try {
    const { message, vehicleId, scanId, history = [], lang = 'es' } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
const role = req.user.role || 'usuario';
let contextLines = [];
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

const gruaContext = gruasDisponibles.length > 0
  ? `\n\nGRÚAS DISPONIBLES EN HOODAI:\n` +
    gruasDisponibles.map((g, i) =>
      `${i+1}. ${g.businessName || g.name} | Tel: ${g.phone || 'N/D'} | Zona: ${g.coverageZone || g.address || 'N/D'}`
    ).join('\n') +
    `\nSi el usuario necesita grúa, indícale que use el botón Solicitar Grúa.`
  : `\n\nNo hay grúas HoodAI disponibles ahora.`;

// ── Talleres registrados ──
const talleresRegistrados = await User.find({ role: 'taller' })
  .select('name businessName phone address coverageZone specialties').lean();

const tallerContext = talleresRegistrados.length > 0
  ? `\n\nTALLERES EN HOODAI:\n` +
    talleresRegistrados.map((t, i) =>
      `${i+1}. ${t.businessName || t.name} | Tel: ${t.phone || 'N/D'} | Zona: ${t.coverageZone || t.address || 'N/D'}` +
      (t.specialties?.length ? ` | Especialidades: ${t.specialties.join(', ')}` : '')
    ).join('\n') +
    `\nSi necesita taller, indícale que use el botón Buscar Taller.`
  : `\n\nNo hay talleres HoodAI registrados aún.`;

// ── Tiendas de repuestos (preview para el asesor) ──
const tiendasRepuestos = await User.find({ role: 'repuestos' })
  .select('name businessName phone address coverageZone').lean();

const repuestoContext = tiendasRepuestos.length > 0
  ? `\n\nTIENDAS DE REPUESTOS EN HOODAI:\n` +
    tiendasRepuestos.map((t, i) =>
      `${i+1}. ${t.businessName || t.name} | Tel: ${t.phone || 'N/D'} | Zona: ${t.coverageZone || t.address || 'N/D'}`
    ).join('\n') +
    `\nSi el usuario menciona una pieza específica, indícale que use el botón Buscar Repuesto para localizar la tienda con esa pieza en stock.`
  : `\n\nNo hay tiendas de repuestos HoodAI registradas aún.`;

const roleContext = {
  usuario:   'El usuario es un conductor normal que necesita orientación mecánica clara y sencilla.',
  taller:    'El usuario es un taller mecánico. Puede usar lenguaje técnico. Ayúdalo con diagnósticos avanzados.',
  grua:      'El usuario opera un servicio de grúas. Ayúdalo con logística y protocolos de rescate vehicular.',
  repuestos: 'El usuario es una tienda de repuestos. Ayúdalo con compatibilidad de piezas e inventario.',
};

const systemPrompt =
  `Eres Hoodai — Tu aliado en asesorías y emergencias mecánicas.\n` +
  `${roleContext[role] || roleContext.usuario}\n` +
  `${contextLines.join(' ')}\n` +
  gruaContext + tallerContext + repuestoContext +
  `\nTono: ejecutivo, calmado, pedagógico. Respuestas concisas.\n` +
  `IMPORTANTE: Responde SIEMPRE en texto plano. Prohibido usar negritas, cursivas, guiones o listas con viñetas. No uses Markdown.\n` +
  `Cuando el usuario mencione una pieza o repuesto específico, nómbrala claramente en tu respuesta para que el sistema pueda buscarla.`;

const messages = [
  ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
  { role: 'user', content: message },
];

const response = await client.messages.create({
  model: 'claude-opus-4-6', max_tokens: 512,
  system: systemPrompt, messages,
});

// Limpieza de seguridad para asegurar texto plano
let reply = response.content[0].text;
reply = reply.replace(/\*\*|\*|__/g, '').replace(/^- /gm, '').replace(/^#+ /gm, '');

const sugierGrua     = needsGrua(message)     || needsGrua(reply);
const sugierTaller   = needsTaller(message)    || needsTaller(reply);
const sugierRepuesto = needsRepuesto(message)  || needsRepuesto(reply);

await req.user.consumirUso();
res.json({
  reply, sugierGrua, sugierTaller, sugierRepuesto,
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
    model: 'claude-opus-4-6', max_tokens: 5, messages: [{ role: 'user', content:
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
  mensaje: `Grúa asignada: ${gruaAsignada.businessName || gruaAsignada.name}. Contáctala al ${gruaAsignada.phone || 'número no registrado'}.`,
});

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ── POST /api/chat/buscar-taller ───────────────────────────────────────────
router.post('/buscar-taller', auth, async (req, res) => {
  try {
    const { lat, lon, vehicleId, marcaBuscada } = req.body;
let marca = marcaBuscada || '';
if (!marca && vehicleId) {
  const v = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id }).lean();
  if (v) marca = v.make;
}

const todosTalleres = await User.find({ role: 'taller' })
  .select('name businessName phone address coverageZone specialties').lean();

if (!todosTalleres.length)
  return res.status(404).json({ error: 'No hay talleres HoodAI registrados aún.' });

const especializados = marca
  ? todosTalleres.filter(t =>
      t.specialties?.some(s => s.toLowerCase().includes(marca.toLowerCase()))
    )
  : [];
const candidatos = especializados.length > 0 ? especializados : todosTalleres;

let tallerAsignado = candidatos[0];
if (lat && lon && candidatos.length > 1) {
  const lista = candidatos.map((t, i) =>
    `${i}: ${t.businessName || t.name}, zona: ${t.coverageZone || t.address || 'no especificada'}`
  ).join('\n');
  const aiRes = await client.messages.create({
    model: 'claude-opus-4-6', max_tokens: 5,
    messages: [{ role: 'user', content:
      `Usuario en lat:${lat}, lon:${lon}. Marca: "${marca}".\nTalleres:\n${lista}\nResponde SOLO el número índice.`
    }],
  });
  const idx = parseInt(aiRes.content[0].text.trim());
  if (!isNaN(idx) && candidatos[idx]) tallerAsignado = candidatos[idx];
}

res.json({
  taller: {
    nombre:         tallerAsignado.businessName || tallerAsignado.name,
    telefono:       tallerAsignado.phone        || 'No disponible',
    zona:           tallerAsignado.coverageZone || tallerAsignado.address || 'No especificada',
    especialidades: tallerAsignado.specialties  || [],
  },
  marca,
  esEspecializado: especializados.length > 0,
  coordenadas: lat && lon ? { lat, lon } : null,
  mensaje: `Taller encontrado: ${tallerAsignado.businessName || tallerAsignado.name}. Contáctalo al ${tallerAsignado.phone || 'número no registrado'}.`,
});

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ── POST /api/chat/buscar-repuesto ─────────────────────────────────────────
router.post('/buscar-repuesto', auth, async (req, res) => {
  try {
    const { lat, lon, vehicleId, piezaTexto } = req.body;
// Obtener marca del vehículo
let marca = '';
if (vehicleId) {
  const v = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id }).lean();
  if (v) marca = v.make;
}

// Extraer nombre de la pieza con IA si no viene explícito
const pieza = piezaTexto || await extractPieza(piezaTexto || '');

// Buscar repuestos en stock compatibles con la marca
const filtro = { stock: { $gt: 0 } };
if (pieza && pieza !== 'repuesto') filtro.nombre = { $regex: pieza, $options: 'i' };
if (marca) filtro.compatibleCon = { $regex: marca, $options: 'i' };

const repuestosEncontrados = await Repuesto.find(filtro)
  .populate('tiendaId', 'businessName name phone address coverageZone')
  .limit(10).lean();

if (!repuestosEncontrados.length) {
  // Si no hay por pieza+marca, buscar tiendas generales
  const tiendas = await User.find({ role: 'repuestos' })
    .select('name businessName phone address coverageZone').lean();

  if (!tiendas.length)
    return res.status(404).json({ error: 'No hay tiendas de repuestos HoodAI registradas.' });

  return res.json({
    tienda: {
      nombre:   tiendas[0].businessName || tiendas[0].name,
      telefono: tiendas[0].phone        || 'No disponible',
      zona:     tiendas[0].coverageZone || tiendas[0].address || 'No especificada',
    },
    piezas:        [],
    pieza,
    marca,
    stockExacto:   false,
    coordenadas:   lat && lon ? { lat, lon } : null,
    mensaje: `Tienda sugerida: ${tiendas[0].businessName || tiendas[0].name}. Consulta disponibilidad al ${tiendas[0].phone || 'número no registrado'}.`,
  });
}

// Agrupar por tienda y seleccionar la mejor según GPS
const tiendaMap = {};
for (const r of repuestosEncontrados) {
  const tid = r.tiendaId?._id?.toString();
  if (!tid) continue;
  if (!tiendaMap[tid]) tiendaMap[tid] = { tienda: r.tiendaId, piezas: [] };
  tiendaMap[tid].piezas.push({
    nombre:     r.nombre,
    referencia: r.referencia,
    precio:     r.precio,
    moneda:     r.moneda,
    stock:      r.stock,
    delivery:   r.delivery,
  });
}

const tiendasConStock = Object.values(tiendaMap);
let seleccion = tiendasConStock[0];

// Usar IA para elegir la más cercana si hay GPS y múltiples tiendas
if (lat && lon && tiendasConStock.length > 1) {
  const lista = tiendasConStock.map((ts, i) =>
    `${i}: ${ts.tienda.businessName || ts.tienda.name}, zona: ${ts.tienda.coverageZone || ts.tienda.address || 'no especificada'}`
  ).join('\n');
  const aiRes = await client.messages.create({
    model: 'claude-opus-4-6', max_tokens: 5,
    messages: [{ role: 'user', content:
      `Usuario en lat:${lat}, lon:${lon}. Busca pieza "${pieza}" para ${marca}.\nTiendas:\n${lista}\nResponde SOLO el número índice de la más cercana.`
    }],
  });
  const idx = parseInt(aiRes.content[0].text.trim());
  if (!isNaN(idx) && tiendasConStock[idx]) seleccion = tiendasConStock[idx];
}

res.json({
  tienda: {
    nombre:   seleccion.tienda.businessName || seleccion.tienda.name,
    telefono: seleccion.tienda.phone        || 'No disponible',
    zona:     seleccion.tienda.coverageZone || seleccion.tienda.address || 'No especificada',
  },
  piezas:      seleccion.piezas,
  pieza,
  marca,
  stockExacto: true,
  coordenadas: lat && lon ? { lat, lon } : null,
  mensaje: `Repuesto encontrado en: ${seleccion.tienda.businessName || seleccion.tienda.name}. Contacto: ${seleccion.tienda.phone || 'número no registrado'}.`,
});

  } catch (e) {
    console.error('Buscar repuesto error:', e);
    res.status(500).json({ error: e.message });
  }
});
module.exports = router;
