const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const auth      = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const Vehicle   = require('../models/Vehicle');
const mongoose  = require('mongoose');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Schema simple inline para guardar valoraciones
const valoracionSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  vehicleId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
  estadoMecanico:   { type: Object, default: {} },
  estetica:         { type: Object, default: {} },
  recorrido:        { type: Object, default: {} },
  documentacion:    { type: Object, default: {} },
  mercado:          { type: Object, default: {} },
  valorEstimado:    { type: String, default: '' },
  depreciacion:     { type: String, default: '' },
  puntajeTotal:     { type: Number, default: 0 },
  resumen:          { type: String, default: '' },
  recomendaciones:  [{ type: String }],
  precioMercadoIA:  { type: String, default: '' },
  fuentesPrecio:    [{ type: String }],
  rawResponse:      { type: String, default: '' },
  createdAt:        { type: Date, default: Date.now },
});

const Valoracion = mongoose.models.Valoracion || mongoose.model('Valoracion', valoracionSchema);

/* ─────────────────────────────────────────────────────────────────
   HELPER: buscar precios de mercado usando web_search tool
───────────────────────────────────────────────────────────────── */
async function buscarPreciosMercado({ make, model, year, pais }) {
  const paisNorm = pais || 'Venezuela';

  const systemSearch = `Eres un analista de precios automotores para ${paisNorm}.
Debes buscar en páginas de clasificados de vehículos usados (tucarro.com, tucarrito.com, olx.com.ve, mercadolibre.com.ve, encuentra24.com, carros.com, etc.) los precios reales publicados para el vehículo solicitado.
Regla crítica: OMITE precios que sean más del 40% más baratos que el resto — son probables estafas o errores.
Responde ÚNICAMENTE con JSON válido, sin texto adicional ni markdown:
{"precios_encontrados":[numeros],"precio_promedio_filtrado":numero,"rango_estimado":"USD X,XXX – USD X,XXX","fuentes_consultadas":["sitio1","sitio2"],"observacion":"texto breve"}`;

  try {
    const searchMsg = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      tool_choice: { type: 'auto' },
      system: systemSearch,
      messages: [{
        role: 'user',
        content: `Busca precios de venta actuales del ${year} ${make} ${model} en ${paisNorm}. Consulta sitios de clasificados automotores locales. Filtra posibles estafas (precios demasiado bajos). Dame el promedio real del mercado.`
      }],
    });

    let resultText = '';
    for (const block of searchMsg.content) {
      if (block.type === 'text') resultText += block.text;
    }

    const clean = resultText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      precioPromedio:  parsed.precio_promedio_filtrado || null,
      rangoEstimado:   parsed.rango_estimado           || null,
      fuentes:         parsed.fuentes_consultadas       || [],
      resumenBusqueda: parsed.observacion               || '',
      preciosList:     parsed.precios_encontrados       || [],
    };
  } catch (err) {
    console.warn('[buscarPreciosMercado] Error:', err.message);
    return { precioPromedio: null, rangoEstimado: null, fuentes: [], resumenBusqueda: '', preciosList: [] };
  }
}

/* ─────────────────────────────────────────────────────────────────
   POST /api/valoracion
───────────────────────────────────────────────────────────────── */
router.post('/', auth, checkUsos, async (req, res) => {
  try {
    if (req.user.plan !== 'gold')
      return res.status(403).json({ error: 'La Valoración Vehicular está disponible solo en el Plan Oro 🥇' });

    const rolesPermitidos = ['usuario', 'seguro'];
    if (!rolesPermitidos.includes(req.user.role))
      return res.status(403).json({ error: 'Esta función es exclusiva para conductores y aseguradoras.' });

    const { vehicleId, estadoMecanico, estetica, recorrido, documentacion, mercado } = req.body;

    let vehicleContext = '';
    let vehicle = null;
    let vehicleMake = '', vehicleModel = '', vehicleYear = '', vehiclePais = 'Venezuela';

    if (vehicleId) {
      vehicle = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id });
      if (vehicle) {
        vehicleMake  = vehicle.make  || '';
        vehicleModel = vehicle.model || '';
        vehicleYear  = vehicle.year  ? String(vehicle.year) : '';
        vehiclePais  = vehicle.pais  || 'Venezuela';
        vehicleContext = `Vehículo: ${vehicleYear} ${vehicleMake} ${vehicleModel}${vehicle.engine ? ' ' + vehicle.engine : ''}${vehicle.placa ? ' | Placa: ' + vehicle.placa : ''}${vehicle.pais ? ' | País: ' + vehicle.pais : ''}`;
      }
    }

    if (!vehicleYear && recorrido?.anio) vehicleYear = String(recorrido.anio);

    /* ── 1. Investigar precios de mercado en tiempo real ── */
    let mktData = { precioPromedio: null, rangoEstimado: null, fuentes: [], resumenBusqueda: '', preciosList: [] };
    if (vehicleMake && vehicleModel) {
      mktData = await buscarPreciosMercado({ make: vehicleMake, model: vehicleModel, year: vehicleYear, pais: vehiclePais });
    }

    const mercadoContextIA = mktData.precioPromedio
      ? `\n\n🔍 DATOS REALES DE MERCADO (obtenidos de sitios de clasificados en tiempo real):
- Precios publicados encontrados: ${mktData.preciosList.map(p => '$' + Number(p).toLocaleString()).join(', ')}
- Promedio filtrado (descartando posibles estafas): $${Number(mktData.precioPromedio).toLocaleString()}
- Rango de mercado: ${mktData.rangoEstimado}
- Fuentes: ${mktData.fuentes.join(', ')}
- Observación: ${mktData.resumenBusqueda}
→ Usa estos datos como base para "valorEstimado" y "precioMercadoIA". Ajusta según condición del vehículo.`
      : `\n\nNota: No se obtuvieron precios en línea. Usa tu conocimiento del mercado ${vehiclePais} para estimar.`;

    /* ── 2. Valoración principal ── */
    const systemPrompt = `Eres el Asesor Mecánico IA de HoodAI, experto en valoración vehicular latinoamericana.
${vehicleContext}
${mercadoContextIA}

Responde SOLO con este JSON (sin markdown, sin texto adicional):
{
  "puntajeTotal": <0-100>,
  "valorEstimado": "<rango USD basado en datos reales de mercado, ej: $8,500 – $10,200>",
  "precioMercadoIA": "<precio promedio de mercado calculado con datos reales, ej: $9,350>",
  "depreciacion": "<ej: 12% anual>",
  "resumen": "<análisis 3-4 oraciones mencionando los precios investigados y ajuste por condición>",
  "categorias": {
    "estadoMecanico":   { "puntaje": <0-100>, "comentario": "<observación>" },
    "estetica":         { "puntaje": <0-100>, "comentario": "<observación>" },
    "recorrido":        { "puntaje": <0-100>, "comentario": "<observación>" },
    "documentacion":    { "puntaje": <0-100>, "comentario": "<observación>" },
    "mercado":          { "puntaje": <0-100>, "comentario": "<observación basada en precios reales investigados>" }
  },
  "recomendaciones": ["<rec1>", "<rec2>", "<rec3>"],
  "alertas": ["<alerta si aplica>"],
  "fuentesPrecio": [${mktData.fuentes.map(f => `"${f}"`).join(', ')}]
}`;

    const userMessage = `Datos del vehículo para valoración:

📋 ESTADO MECÁNICO:
- Motor: ${estadoMecanico?.motor || 'No especificado'}
- Transmisión: ${estadoMecanico?.transmision || 'No especificado'}
- Frenos: ${estadoMecanico?.frenos || 'No especificado'}
- Suspensión: ${estadoMecanico?.suspension || 'No especificado'}
- Sistema eléctrico: ${estadoMecanico?.electrico || 'No especificado'}
- Aire acondicionado: ${estadoMecanico?.ac || 'No especificado'}
- Observaciones: ${estadoMecanico?.observaciones || 'Ninguna'}

🎨 ESTÉTICA:
- Pintura: ${estetica?.pintura || 'No especificado'}
- Golpes: ${estetica?.golpes || 'No especificado'}
- Interior: ${estetica?.interior || 'No especificado'}
- Vidrios: ${estetica?.vidrios || 'No especificado'}
- Llantas: ${estetica?.llantas || 'No especificado'}
- Observaciones: ${estetica?.observaciones || 'Ninguna'}

📏 RECORRIDO:
- Kilómetros: ${recorrido?.km || 'No especificado'} km
- Año: ${recorrido?.anio || 'No especificado'}
- Propietarios anteriores: ${recorrido?.propietarios || 'No especificado'}
- Accidentes: ${recorrido?.accidentes || 'No especificado'}
- Mantenimiento: ${recorrido?.mantenimiento || 'No especificado'}

📄 DOCUMENTACIÓN:
- Título: ${documentacion?.titulo || 'No especificado'}
- Registro: ${documentacion?.registro || 'No especificado'}
- Seguro: ${documentacion?.seguro || 'No especificado'}
- Revisión técnica: ${documentacion?.revision || 'No especificado'}
- Situación legal: ${documentacion?.situacion || 'Sin observaciones'}

📊 MERCADO:
- Precio pedido por propietario: ${mercado?.precioPedido ? '$' + Number(mercado.precioPedido).toLocaleString() : 'No especificado'}
- Demanda en zona: ${mercado?.demanda || 'No especificado'}
- Urgencia de venta: ${mercado?.urgencia || 'No especificado'}
- Observaciones: ${mercado?.observaciones || 'Ninguna'}`;

    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const raw = message.content[0].text.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      parsed = {
        puntajeTotal: 50, valorEstimado: 'No calculado', precioMercadoIA: 'No calculado',
        depreciacion: 'No calculado', resumen: raw,
        categorias: {}, recomendaciones: [], alertas: [], fuentesPrecio: [],
      };
    }

    if (!parsed.fuentesPrecio?.length) parsed.fuentesPrecio = mktData.fuentes;

    const valoracion = await Valoracion.create({
      userId: req.user._id, vehicleId: vehicle?._id || null,
      estadoMecanico, estetica, recorrido, documentacion, mercado,
      valorEstimado:   parsed.valorEstimado   || '',
      depreciacion:    parsed.depreciacion     || '',
      puntajeTotal:    parsed.puntajeTotal     || 0,
      resumen:         parsed.resumen          || '',
      recomendaciones: parsed.recomendaciones  || [],
      precioMercadoIA: parsed.precioMercadoIA  || '',
      fuentesPrecio:   parsed.fuentesPrecio    || [],
      rawResponse: raw,
    });

    await req.user.consumirUso();

    res.json({
      valoracionId: valoracion._id,
      ...parsed,
      usosRestantes: req.user.usosRestantes + req.user.usosExtra,
    });

  } catch (e) {
    console.error('Valoracion error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/valoracion
router.get('/', auth, async (req, res) => {
  try {
    const valoraciones = await Valoracion.find({ userId: req.user._id })
      .populate('vehicleId', 'make model year placa')
      .sort('-createdAt')
      .limit(20);
    res.json(valoraciones);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
