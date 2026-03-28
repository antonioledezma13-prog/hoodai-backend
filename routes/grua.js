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
      disponible: req.user.disponible || false,
      usosRestantes: req.user.usosRestantes + req.user.usosExtra,
      plan: req.user.plan,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
