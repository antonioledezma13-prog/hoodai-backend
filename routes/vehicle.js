const router  = require('express').Router();
const auth    = require('../middleware/auth');
const Vehicle = require('../models/Vehicle');

// GET /api/vehicle — list user vehicles
router.get('/', auth, async (req, res) => {
  const vehicles = await Vehicle.find({ userId: req.user._id }).sort('-createdAt');
  res.json(vehicles);
});

// POST /api/vehicle — add vehicle
router.post('/', auth, async (req, res) => {
  try {
    const { make, model, year, engine, vin, nickname } = req.body;
    if (!make || !model || !year)
      return res.status(400).json({ error: 'make, model and year are required' });
    const vehicle = await Vehicle.create({ userId: req.user._id, make, model, year, engine, vin, nickname });
    res.status(201).json(vehicle);
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
