const mongoose = require('mongoose');

// Tabla de mantenimientos recomendados por ensambladora
const mantenimientoSchema = new mongoose.Schema({
  ensambladoId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  marca:        { type: String, required: true },
  modelo:       { type: String, default: '' },
  anioDesde:    { type: Number, default: 2000 },
  anioHasta:    { type: Number, default: 2030 },
  kmIntervalo:  { type: Number, required: true }, // cada cuántos km
  tipo:         { type: String, required: true }, // "Aceite", "Frenos", "Correa"
  descripcion:  { type: String, default: '' },
  createdAt:    { type: Date, default: Date.now },
});

module.exports = mongoose.model('Mantenimiento', mantenimientoSchema);
