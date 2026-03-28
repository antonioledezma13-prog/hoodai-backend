const router         = require('express').Router();
const auth           = require('../middleware/auth');
const checkUsos      = require('../middleware/checkUsos');
const Mantenimiento  = require('../models/Mantenimiento');
const Repuesto       = require('../models/Repuesto');
const Vehicle        = require('../models/Vehicle');
const User           = require('../models/User');

// GET /api/ensambladora/mantenimientos — consulta pública para HoodAI
router.get('/mantenimientos', async (req, res) => {
  try {
    const { marca, modelo, anio, km } = req.query;
    const filtro = {};
    if (marca) filtro.marca = { $regex: marca, $options: 'i' };
    if (modelo) filtro.modelo = { $regex: modelo, $options: 'i' };
    if (anio) {
      filtro.anioDesde = { $lte: parseInt(anio) };
      filtro.anioHasta = { $gte: parseInt(anio) };
    }
    const items = await Mantenimiento.find(filtro)
      .populate('ensambladoId', 'businessName');
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ensambladora/mantenimiento — ensambladora registra intervalo
router.post('/mantenimiento', auth, checkUsos, async (req, res) => {
  try {
    if (req.user.role !== 'ensambladora')
      return res.status(403).json({ error: 'Solo ensambladoras' });
    const { marca, modelo, anioDesde, anioHasta, kmIntervalo, tipo, descripcion } = req.body;
    const item = await Mantenimiento.create({
      ensambladoId: req.user._id, marca, modelo,
      anioDesde, anioHasta, kmIntervalo, tipo, descripcion,
    });
    await req.user.consumirUso();
    res.status(201).json({ item, usosRestantes: req.user.usosRestantes + req.user.usosExtra });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ensambladora/mis-mantenimientos — ensambladora ve sus registros
router.get('/mis-mantenimientos', auth, async (req, res) => {
  try {
    if (req.user.role !== 'ensambladora')
      return res.status(403).json({ error: 'Solo ensambladoras' });
    const items = await Mantenimiento.find({ ensambladoId: req.user._id });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/ensambladora/mantenimiento/:id
router.delete('/mantenimiento/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'ensambladora')
      return res.status(403).json({ error: 'Solo ensambladoras' });
    await Mantenimiento.findOneAndDelete({ _id: req.params.id, ensambladoId: req.user._id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ensambladora/data-postventa — stats de vehículos de su marca en el sistema
router.get('/data-postventa', auth, async (req, res) => {
  try {
    if (req.user.role !== 'ensambladora')
      return res.status(403).json({ error: 'Solo ensambladoras' });

    const marcas = req.user.marcasVehiculo || [];
    if (!marcas.length) return res.json({ total: 0, porModelo: [], fallasFrecuentes: [] });

    const vehiculos = await Vehicle.find({
      make: { $in: marcas.map(m => new RegExp(m, 'i')) }
    }).select('make model year');

    // Agrupar por modelo
    const porModelo = {};
    vehiculos.forEach(v => {
      const key = v.make + ' ' + v.model;
      porModelo[key] = (porModelo[key] || 0) + 1;
    });

    res.json({
      total: vehiculos.length,
      marcas,
      porModelo: Object.entries(porModelo).map(([modelo, cantidad]) => ({ modelo, cantidad })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
