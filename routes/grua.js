const router = require('express').Router();
const auth   = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const User   = require('../models/User');

// GET /api/grua/disponibles — para que HoodAI consulte grúas activas
router.get('/disponibles', async (req, res) => {
  try {
    const gruas = await User.find({ role: 'grua', disponible: true })
      .select('name businessName phone address coverageZone');
    res.json(gruas);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/grua/disponibilidad — el operador activa/desactiva su disponibilidad
router.put('/disponibilidad', auth, checkUsos, async (req, res) => {
  try {
    if (req.user.role !== 'grua')
      return res.status(403).json({ error: 'Solo operadores de grúa' });

    const { disponible } = req.body;
    req.user.disponible = disponible;
    await req.user.save();
    await req.user.consumirUso();

    res.json({
      disponible: req.user.disponible,
      usosRestantes: req.user.usosRestantes + req.user.usosExtra,
      message: disponible ? '✅ Ahora estás disponible para servicios' : '⏸ Ahora estás inactivo',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/grua/estado — el operador consulta su estado actual
router.get('/estado', auth, async (req, res) => {
  try {
    if (req.user.role !== 'grua')
      return res.status(403).json({ error: 'Solo operadores de grúa' });
    res.json({
      disponible:    req.user.disponible    || false,
      usosRestantes: req.user.usosRestantes + req.user.usosExtra,
      plan:          req.user.plan,
      phone:         req.user.phone         || '',
      coverageZone:  req.user.coverageZone  || '',
      businessName:  req.user.businessName  || '',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/grua/perfil — el operador actualiza sus datos de contacto y zona
router.put('/perfil', auth, async (req, res) => {
  try {
    if (req.user.role !== 'grua')
      return res.status(403).json({ error: 'Solo operadores de grúa' });
    const { businessName, phone, coverageZone } = req.body;
    if (businessName !== undefined) req.user.businessName = businessName;
    if (phone        !== undefined) req.user.phone        = phone;
    if (coverageZone !== undefined) req.user.coverageZone = coverageZone;
    await req.user.save();
    res.json({ ok: true, businessName: req.user.businessName, phone: req.user.phone, coverageZone: req.user.coverageZone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// POST /api/grua/notificar — conductor notifica a grúas disponibles con su GPS + datos
router.post('/notificar', auth, async (req, res) => {
  try {
    if (req.user.role !== 'usuario' && req.user.role !== 'taller')
      return res.status(403).json({ error: 'Solo conductores pueden solicitar grúa' });

    const { lat, lng, descripcion, vehiculo } = req.body;

    // Buscar grúas disponibles
    const gruas = await User.find({ role: 'grua', disponible: true })
      .select('_id name businessName phone coverageZone solicitudesGrua');

    if (!gruas.length)
      return res.status(404).json({ error: 'No hay grúas disponibles en este momento' });

    const solicitud = {
      clienteId:     req.user._id,
      clienteNombre: req.user.name || '',
      clientePhone:  req.user.phone || '',
      vehiculo:      vehiculo || {},
      lat:           lat   || null,
      lng:           lng   || null,
      descripcion:   descripcion || '',
      fecha:         new Date(),
      estado:        'pendiente',
    };

    // Insertar solicitud en TODAS las grúas disponibles
    await User.updateMany(
      { role: 'grua', disponible: true },
      { $push: { solicitudesGrua: solicitud } }
    );

    res.json({
      ok: true,
      gruasNotificadas: gruas.length,
      mensaje: `✅ Se notificó a ${gruas.length} grúa${gruas.length > 1 ? 's' : ''} disponible${gruas.length > 1 ? 's' : ''}. Pronto recibirás confirmación.`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/grua/solicitudes — operador de grúa consulta sus solicitudes pendientes
router.get('/solicitudes', auth, async (req, res) => {
  try {
    if (req.user.role !== 'grua')
      return res.status(403).json({ error: 'Solo operadores de grúa' });

    // Recargar el usuario para obtener las solicitudes actualizadas
    const user = await User.findById(req.user._id).select('solicitudesGrua');
    const pendientes = (user.solicitudesGrua || [])
      .filter(s => s.estado === 'pendiente')
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    res.json(pendientes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/grua/solicitudes/:solId/aceptar — operador acepta una solicitud
router.put('/solicitudes/:solId/aceptar', auth, async (req, res) => {
  try {
    if (req.user.role !== 'grua')
      return res.status(403).json({ error: 'Solo operadores de grúa' });

    // 1. Marcar la solicitud como aceptada
    const gruaDoc = await User.findOneAndUpdate(
      { _id: req.user._id, 'solicitudesGrua._id': req.params.solId },
      { $set: { 'solicitudesGrua.$.estado': 'aceptada' } },
      { new: true }
    );

    // 2. Encontrar la solicitud para obtener el clienteId
    const solicitud = gruaDoc?.solicitudesGrua?.find(
      s => s._id.toString() === req.params.solId
    );

    // 3. Empujar notificación al documento del cliente
    if (solicitud?.clienteId) {
      await User.updateOne(
        { _id: solicitud.clienteId },
        {
          $push: {
            notificacionesGrua: {
              gruaId:     req.user._id,
              gruaNombre: req.user.businessName || req.user.name || 'Operador de Grúa',
              gruaPhone:  req.user.phone || '',
              gruaZona:   req.user.coverageZone || '',
              fecha:      new Date(),
              leida:      false,
            }
          }
        }
      );
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/grua/notificaciones — conductor consulta si una grúa aceptó su solicitud
router.get('/notificaciones', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('notificacionesGrua');
    const nuevas = (user.notificacionesGrua || []).filter(n => !n.leida);

    // Marcar todas como leídas
    if (nuevas.length > 0) {
      await User.updateOne(
        { _id: req.user._id },
        { $set: { 'notificacionesGrua.$[].leida': true } }
      );
    }

    res.json(nuevas);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/grua/solicitudes/:solId/finalizar — operador finaliza el servicio
router.put('/solicitudes/:solId/finalizar', auth, async (req, res) => {
  try {
    if (req.user.role !== 'grua')
      return res.status(403).json({ error: 'Solo operadores de grúa' });

    await User.updateOne(
      { _id: req.user._id, 'solicitudesGrua._id': req.params.solId },
      { $set: { 'solicitudesGrua.$.estado': 'cancelada' } } // reutilizamos 'cancelada' = completada
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
