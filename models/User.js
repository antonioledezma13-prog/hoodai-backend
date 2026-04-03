const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const PLAN_LIMITS  = { free: 3, paid: 25, gold: 100 };
const PLAN_PRICES  = {
  usuario: 6, taller: 3, grua: 3,
  repuestos: 3, ensambladora: 3, seguro: 3,
};
const PLAN_PRICES_GOLD = {
  usuario: 30, taller: 20, grua: 20,
  repuestos: 20, ensambladora: 20, seguro: 20,
};

const userSchema = new mongoose.Schema({
  name:          { type: String, required: true, trim: true },
  email:         { type: String, required: true, unique: true, lowercase: true },
  password:      { type: String, required: true },
  lang:          { type: String, enum: ['es', 'en'], default: 'es' },
  role:          { type: String, enum: ['usuario', 'taller', 'grua', 'repuestos', 'ensambladora', 'seguro'], default: 'usuario' },
  businessName:  { type: String, default: '' },
  phone:         { type: String, default: '' },
  address:       { type: String, default: '' },
  specialties:   [{ type: String }],
  coverageZone:  { type: String, default: '' },
  disponible:    { type: Boolean, default: false },
  // Ensambladora
  marcasVehiculo: [{ type: String }], // marcas que representa
  // Notificaciones de aceptación que llegan al conductor
  notificacionesGrua: [{
    gruaId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    gruaNombre:   { type: String, default: '' },
    gruaPhone:    { type: String, default: '' },
    gruaZona:     { type: String, default: '' },
    fecha:        { type: Date,   default: Date.now },
    leida:        { type: Boolean, default: false },
  }],
  // Solicitudes de grúa pendientes (push desde conductores, pull desde operador)
  solicitudesGrua: [{
    clienteId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    clienteNombre:{ type: String, default: '' },
    clientePhone: { type: String, default: '' },
    vehiculo:     { type: Object, default: {} },
    lat:          { type: Number, default: null },
    lng:          { type: Number, default: null },
    descripcion:  { type: String, default: '' },
    fecha:        { type: Date,   default: Date.now },
    estado:       { type: String, enum: ['pendiente','aceptada','cancelada'], default: 'pendiente' },
  }],
  // Plan y usos
  plan:              { type: String, enum: ['free', 'paid', 'gold'], default: 'free' },
  usosRestantes:     { type: Number, default: 3 },
  usosExtra:         { type: Number, default: 0 },
  planExpira:        { type: Date, default: null },
  paypalOrderId:     { type: String, default: '' },
  createdAt:         { type: Date, default: Date.now },
});

userSchema.methods.tieneUsos = function() {
  return (this.usosRestantes + this.usosExtra) > 0;
};

userSchema.methods.consumirUso = async function() {
  if (this.usosExtra > 0) this.usosExtra -= 1;
  else if (this.usosRestantes > 0) this.usosRestantes -= 1;
  await this.save();
};

userSchema.methods.activarPlan = async function(paypalOrderId, meses = 1) {
  this.plan = 'paid';
  this.usosRestantes = PLAN_LIMITS.paid;
  this.paypalOrderId = paypalOrderId;
  const expira = new Date();
  expira.setMonth(expira.getMonth() + meses);
  this.planExpira = expira;
  await this.save();
};

userSchema.methods.activarPlanGold = async function(paypalOrderId, meses = 1) {
  this.plan = 'gold';
  this.usosRestantes = PLAN_LIMITS.gold;
  this.paypalOrderId = paypalOrderId;
  const expira = new Date();
  expira.setMonth(expira.getMonth() + meses);
  this.planExpira = expira;
  await this.save();
};

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
module.exports.PLAN_LIMITS      = PLAN_LIMITS;
module.exports.PLAN_PRICES      = PLAN_PRICES;
module.exports.PLAN_PRICES_GOLD = PLAN_PRICES_GOLD;
