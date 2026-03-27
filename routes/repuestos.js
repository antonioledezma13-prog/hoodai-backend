const router   = require('express').Router();
const auth     = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const Repuesto = require('../models/Repuesto');

// GET /api/repuestos/buscar?q=alternador&marca=Toyota — HoodAI consulta disponibilidad
router.get('/buscar', async (req, res) => {
  try {
    const { q, marca } = req.query;
    const filtro = {};
    if (q) filtro.nombre = { $regex: q, $options: 'i' };
    if (marca) filtro.compatibleCon = { $regex: marca, $options: 'i' };
    filtro.stock = { $gt: 0 };

    const repuestos = await Repuesto.find(filtro)
      .populate('tiendaId', 'businessName phone address')
      .limit(10);
    res.json(repuestos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/repuestos/mios — la tienda ve su inventario
router.get('/mios', auth, async (req, res) => {
  try {
    if (req.user.role !== 'repuestos')
      return res.status(403).json({ error: 'Solo tiendas de repuestos' });
    const items = await Repuesto.find({ tiendaId: req.user._id });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/repuestos — agregar repuesto al inventario
router.post('/', auth, checkUsos, async (req, res) => {
  try {
    if (req.user.role !== 'repuestos')
      return res.status(403).json({ error: 'Solo tiendas de repuestos' });

    const { nombre, marca, referencia, compatibleCon, precio, moneda, stock, delivery } = req.body;
    const repuesto = await Repuesto.create({
      tiendaId: req.user._id, nombre, marca, referencia,
      compatibleCon, precio, moneda, stock, delivery,
    });
    await req.user.consumirUso();
    res.status(201).json({ repuesto, usosRestantes: req.user.usosRestantes + req.user.usosExtra });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/repuestos/:id — actualizar repuesto
router.put('/:id', auth, checkUsos, async (req, res) => {
  try {
    if (req.user.role !== 'repuestos')
      return res.status(403).json({ error: 'Solo tiendas de repuestos' });

    const repuesto = await Repuesto.findOneAndUpdate(
      { _id: req.params.id, tiendaId: req.user._id },
      { ...req.body, updatedAt: new Date() },
      { new: true }
    );
    if (!repuesto) return res.status(404).json({ error: 'No encontrado' });
    await req.user.consumirUso();
    res.json({ repuesto, usosRestantes: req.user.usosRestantes + req.user.usosExtra });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/repuestos/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'repuestos')
      return res.status(403).json({ error: 'Solo tiendas de repuestos' });
    await Repuesto.findOneAndDelete({ _id: req.params.id, tiendaId: req.user._id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
