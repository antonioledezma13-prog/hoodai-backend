const router = require('express').Router();
const auth   = require('../middleware/auth');
const Scan   = require('../models/Scan');

// GET /api/history
router.get('/', auth, async (req, res) => {
  const scans = await Scan.find({ userId: req.user._id })
    .populate('vehicleId', 'make model year')
    .sort('-createdAt')
    .limit(50);
  res.json(scans);
});

// GET /api/history/:id
router.get('/:id', auth, async (req, res) => {
  const scan = await Scan.findOne({ _id: req.params.id, userId: req.user._id })
    .populate('vehicleId', 'make model year engine');
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json(scan);
});

// DELETE /api/history/:id
router.delete('/:id', auth, async (req, res) => {
  await Scan.deleteOne({ _id: req.params.id, userId: req.user._id });
  res.json({ ok: true });
});

module.exports = router;
