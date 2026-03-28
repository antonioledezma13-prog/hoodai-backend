require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const mongoose = require('mongoose');

const authRoutes         = require('./routes/auth');
const vehicleRoutes      = require('./routes/vehicle');
const analyzeRoutes      = require('./routes/analyze');
const chatRoutes         = require('./routes/chat');
const historyRoutes      = require('./routes/history');
const gruaRoutes         = require('./routes/grua');
const repuestosRoutes    = require('./routes/repuestos');
const pagosRoutes        = require('./routes/pagos');
const seguroRoutes       = require('./routes/seguro');
const ensambladoraRoutes = require('./routes/ensambladora');

const app = express();

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:4173',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Hoodai API', version: '3.0.0' }));

app.use('/api/auth',         authRoutes);
app.use('/api/vehicle',      vehicleRoutes);
app.use('/api/analyze',      analyzeRoutes);
app.use('/api/chat',         chatRoutes);
app.use('/api/history',      historyRoutes);
app.use('/api/grua',         gruaRoutes);
app.use('/api/repuestos',    repuestosRoutes);
app.use('/api/pagos',        pagosRoutes);
app.use('/api/seguro',       seguroRoutes);
app.use('/api/ensambladora', ensambladoraRoutes);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 4000;

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB connected');
    app.listen(PORT, () => console.log(`🚀 Hoodai API v3.0 running on port ${PORT}`));
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
