const mongoose = require('mongoose');

const repuestoSchema = new mongoose.Schema({
  tiendaId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  nombre:      { type: String, required: true, trim: true },
  marca:       { type: String, default: '' },
  referencia:  { type: String, default: '' },
  compatibleCon: [{ type: String }], // marcas de vehículos
  precio:      { type: Number, required: true },
  moneda:      { type: String, enum: ['USD', 'VES'], default: 'USD' },
  stock:       { type: Number, default: 0 },
  delivery:    { type: Boolean, default: false },
  updatedAt:   { type: Date, default: Date.now },
});

module.exports = mongoose.model('Repuesto', repuestoSchema);
