const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const PLAN_LIMITS = {
  free: 3,
  paid: 25,
};

const PLAN_PRICES = {
  usuario:   6,
  taller:    3,
  grua:      3,
  repuestos: 3,
};

const userSchema = new mongoose.Schema({
  name:          { type: String, required: true, trim: true },
  email:         { type: String, required: true, unique: true, lowercase: true },
  password:      { type: String, required: true },
  lang:          { type: String, enum: ['es', 'en'], default: 'es' },
  role:          { type: String, enum: ['usuario', 'taller', 'grua', 'repuestos'], default: 'usuario' },
  businessName:  { type: String, default: '' },
  phone:         { type: String, default: '' },
  address:       { type: String, default: '' },
  specialties:   [{ type: String }],
  coverageZone:  { type: String, default: '' },
  disponible:    { type: Boolean, default: false },

  // Plan y usos
  plan:              { type: String, enum: ['free', 'paid'], default: 'free' },
  usosRestantes:     { type: Number, default: 3 },
  usosExtra:         { type: Number, default: 0 },
  planExpira:        { type: Date, default: null },
  paypalSubId:       { type: String, default: '' },
  paypalOrderId:     { type: String, default: '' },

  createdAt: { type: Date, default: Date.now },
});

// Método para verificar si tiene usos disponibles
userSchema.methods.tieneUsos = function() {
  const total = this.usosRestantes + this.usosExtra;
  return total > 0;
};

// Método para consumir un uso
userSchema.methods.consumirUso = async function() {
  if (this.usosExtra > 0) {
    this.usosExtra -= 1;
  } else if (this.usosRestantes > 0) {
    this.usosRestantes -= 1;
  }
  await this.save();
};

// Método para activar plan pagado
userSchema.methods.activarPlan = async function(paypalOrderId, meses = 1) {
  this.plan = 'paid';
  this.usosRestantes = PLAN_LIMITS.paid;
  this.paypalOrderId = paypalOrderId;
  const expira = new Date();
  expira.setMonth(expira.getMonth() + meses);
  this.planExpira = expira;
  await this.save();
};

// Método para agregar usos extra
userSchema.methods.agregarUsosExtra = async function(cantidad, paypalOrderId) {
  this.usosExtra += cantidad;
  this.paypalOrderId = paypalOrderId;
  await this.save();
};

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function(plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model('User', userSchema);
module.exports.PLAN_LIMITS  = PLAN_LIMITS;
module.exports.PLAN_PRICES  = PLAN_PRICES;
