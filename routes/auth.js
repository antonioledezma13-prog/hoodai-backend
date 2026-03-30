const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const User   = require('../models/User');

const sign = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, lang, role, businessName, phone, address, specialties, coverageZone } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'name, email and password are required' });

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: 'Email already registered' });

    const user = await User.create({ name, email, password, lang, role, businessName, phone, address, specialties, coverageZone });
    res.status(201).json({ token: sign(user._id), user: { id: user._id, name, email, lang, role: user.role, plan: user.plan } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password)))
      return res.status(401).json({ error: 'Invalid credentials' });

    res.json({ token: sign(user._id), user: { id: user._id, name: user.name, email, lang: user.lang, role: user.role, plan: user.plan } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/me — refresca datos del usuario (plan, role, etc.)
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    const token = authHeader.split(' ')[1];
    const jwt   = require('jsonwebtoken');
    const { id } = jwt.verify(token, process.env.JWT_SECRET);
    const user   = await User.findById(id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user._id, name: user.name, email: user.email, lang: user.lang, role: user.role, plan: user.plan });
  } catch (e) {
    res.status(401).json({ error: 'Token inválido' });
  }
});

module.exports = router;
