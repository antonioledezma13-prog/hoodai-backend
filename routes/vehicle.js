const router  = require('express').Router();
const auth    = require('../middleware/auth');
const Vehicle = require('../models/Vehicle');
const User    = require('../models/User');

// GET /api/vehicle — list user vehicles
router.get('/', auth, async (req, res) => {
  const vehicles = await Vehicle.find({ userId: req.user._id }).sort('-createdAt');
  res.json(vehicles);
});

// GET /api/vehicle/seguros — lista seguros registrados en plataforma
router.get('/seguros', auth, async (req, res) => {
  try {
    const seguros = await User.find({ role: 'seguro' }, 'businessName name').lean();
    res.json(seguros.map(s => ({ _id: s._id, nombre: s.businessName || s.name })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vehicle/mis-clientes — seguro ve sus clientes vinculados
router.get('/mis-clientes', auth, async (req, res) => {
  try {
    if (req.user.role !== 'seguro')
      return res.status(403).json({ error: 'Solo aseguradoras' });
    const vehiculos = await Vehicle.find({ seguroId: req.user._id })
      .populate('userId', 'name email phone')
      .sort('-createdAt');
    res.json(vehiculos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vehicle — add vehicle
router.post('/', auth, async (req, res) => {
  try {
    const { make, model, year, engine, vin, nickname, placa, pais, seguroId } = req.body;
    if (!make || !model || !year)
      return res.status(400).json({ error: 'make, model and year are required' });

    let seguroNombre = '';
    if (seguroId) {
      const seg = await User.findById(seguroId);
      seguroNombre = seg?.businessName || seg?.name || '';
    }

    const vehicle = await Vehicle.create({
      userId: req.user._id,
      make, model, year, engine, vin, nickname,
      placa: placa || '',
      pais:  pais  || 'Venezuela',
      seguroId:     seguroId || null,
      seguroNombre,
    });
    res.status(201).json(vehicle);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/vehicle/:id — update vehicle
router.put('/:id', auth, async (req, res) => {
  try {
    const { make, model, year, engine, vin, nickname, placa, pais, seguroId } = req.body;
    let seguroNombre = '';
    if (seguroId) {
      const seg = await User.findById(seguroId);
      seguroNombre = seg?.businessName || seg?.name || '';
    }
    const vehicle = await Vehicle.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { make, model, year, engine, vin, nickname, placa: placa || '', pais: pais || 'Venezuela', seguroId: seguroId || null, seguroNombre },
      { new: true }
    );
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
    res.json(vehicle);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/vehicle/:id
router.delete('/:id', auth, async (req, res) => {
  await Vehicle.deleteOne({ _id: req.params.id, userId: req.user._id });
  res.json({ ok: true });
});

module.exports = router;
