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
  // Datos de entrada
  estadoMecanico:   { type: Object, default: {} },
  estetica:         { type: Object, default: {} },
  recorrido:        { type: Object, default: {} },
  documentacion:    { type: Object, default: {} },
  mercado:          { type: Object, default: {} },
  // Resultado IA
  valorEstimado:    { type: String, default: '' },
  depreciacion:     { type: String, default: '' },
  puntajeTotal:     { type: Number, default: 0 },
  resumen:          { type: String, default: '' },
  recomendaciones:  [{ type: String }],
  rawResponse:      { type: String, default: '' },
  createdAt:        { type: Date, default: Date.now },
});

const Valoracion = mongoose.models.Valoracion || mongoose.model('Valoracion', valoracionSchema);

// POST /api/valoracion — crear nueva valoración vehicular con IA
router.post('/', auth, checkUsos, async (req, res) => {
  try {
    // Solo plan gold
    if (req.user.plan !== 'gold')
      return res.status(403).json({ error: 'La Valoración Vehicular está disponible solo en el Plan Oro 🥇' });

    // Solo usuarios conductores y seguros
    const rolesPermitidos = ['usuario', 'seguro'];
    if (!rolesPermitidos.includes(req.user.role))
      return res.status(403).json({ error: 'Esta función es exclusiva para conductores y aseguradoras.' });

    const {
      vehicleId,
      estadoMecanico,
      estetica,
      recorrido,
      documentacion,
      mercado,
    } = req.body;

    let vehicleContext = '';
    let vehicle = null;
    if (vehicleId) {
      vehicle = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id });
      if (vehicle) {
        vehicleContext = `Vehículo: ${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.engine ? ' ' + vehicle.engine : ''}${vehicle.placa ? ' | Placa: ' + vehicle.placa : ''}${vehicle.pais ? ' | País: ' + vehicle.pais : ''}`;
      }
    }

    const systemPrompt = `Eres el Asesor Mecánico IA de HoodAI, experto en valoración vehicular latinoamericana.
Analiza los datos proporcionados del vehículo y genera una valoración técnica completa.
${vehicleContext}

Considera el mercado venezolano/latinoamericano en tu análisis de precios.

Responde SOLO con este JSON exacto (sin markdown, sin texto adicional):
{
  "puntajeTotal": <número 0-100>,
  "valorEstimado": "<rango en USD, ej: $8,500 – $10,200>",
  "depreciacion": "<porcentaje anual estimado, ej: 12% anual>",
  "resumen": "<análisis ejecutivo en 3-4 oraciones mencionando los puntos clave>",
  "categorias": {
    "estadoMecanico":   { "puntaje": <0-100>, "comentario": "<observación técnica>" },
    "estetica":         { "puntaje": <0-100>, "comentario": "<observación técnica>" },
    "recorrido":        { "puntaje": <0-100>, "comentario": "<observación técnica>" },
    "documentacion":    { "puntaje": <0-100>, "comentario": "<observación técnica>" },
    "mercado":          { "puntaje": <0-100>, "comentario": "<observación técnica>" }
  },
  "recomendaciones": [
    "<recomendación concreta para mejorar valor o resolver problema>",
    "<recomendación concreta>",
    "<recomendación concreta>"
  ],
  "alertas": ["<alerta importante si existe>"]
}`;

    const userMessage = `
Datos del vehículo para valoración:

📋 ESTADO MECÁNICO Y FUNCIONAMIENTO:
- Motor: ${estadoMecanico?.motor || 'No especificado'}
- Transmisión: ${estadoMecanico?.transmision || 'No especificado'}
- Frenos: ${estadoMecanico?.frenos || 'No especificado'}
- Suspensión: ${estadoMecanico?.suspension || 'No especificado'}
- Sistema eléctrico: ${estadoMecanico?.electrico || 'No especificado'}
- Aire acondicionado: ${estadoMecanico?.ac || 'No especificado'}
- Observaciones mecánicas: ${estadoMecanico?.observaciones || 'Ninguna'}

🎨 ESTÉTICA Y CARROCERÍA:
- Estado de pintura: ${estetica?.pintura || 'No especificado'}
- Golpes/abolladuras: ${estetica?.golpes || 'No especificado'}
- Interior/tapicería: ${estetica?.interior || 'No especificado'}
- Vidrios/lunas: ${estetica?.vidrios || 'No especificado'}
- Llantas/rines: ${estetica?.llantas || 'No especificado'}
- Observaciones estéticas: ${estetica?.observaciones || 'Ninguna'}

📏 RECORRIDO Y ANTIGÜEDAD:
- Kilómetros recorridos: ${recorrido?.km || 'No especificado'} km
- Año del vehículo: ${recorrido?.anio || 'No especificado'}
- Propietarios anteriores: ${recorrido?.propietarios || 'No especificado'}
- Historial de accidentes: ${recorrido?.accidentes || 'No especificado'}
- Historial de mantenimiento: ${recorrido?.mantenimiento || 'No especificado'}

📄 DOCUMENTACIÓN:
- Título/Certificado: ${documentacion?.titulo || 'No especificado'}
- Registro vigente: ${documentacion?.registro || 'No especificado'}
- Seguro activo: ${documentacion?.seguro || 'No especificado'}
- Revisión técnica: ${documentacion?.revision || 'No especificado'}
- Situación legal: ${documentacion?.situacion || 'Sin observaciones'}

📊 MERCADO OFERTA/DEMANDA:
- Precio pedido por propietario: ${mercado?.precioPedido || 'No especificado'}
- Precio de mercado referencial: ${mercado?.precioMercado || 'No especificado'}
- Demanda en zona: ${mercado?.demanda || 'No especificado'}
- Urgencia de venta: ${mercado?.urgencia || 'No especificado'}
- Observaciones de mercado: ${mercado?.observaciones || 'Ninguna'}

Genera la valoración completa con todos los campos del JSON solicitado.`;

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
        puntajeTotal: 50,
        valorEstimado: 'No calculado',
        depreciacion: 'No calculado',
        resumen: raw,
        categorias: {},
        recomendaciones: [],
        alertas: [],
      };
    }

    const valoracion = await Valoracion.create({
      userId:    req.user._id,
      vehicleId: vehicle?._id || null,
      estadoMecanico, estetica, recorrido, documentacion, mercado,
      valorEstimado:   parsed.valorEstimado   || '',
      depreciacion:    parsed.depreciacion     || '',
      puntajeTotal:    parsed.puntajeTotal     || 0,
      resumen:         parsed.resumen          || '',
      recomendaciones: parsed.recomendaciones  || [],
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

// GET /api/valoracion — historial de valoraciones del usuario
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
