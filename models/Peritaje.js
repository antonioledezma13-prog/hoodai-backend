const mongoose = require('mongoose');

const peritajeSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  vehicleId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
  aseguradoraId:{ type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Imágenes del accidente (base64 thumbnails)
  imagenes:     [{ type: String }],
  // Análisis IA
  danos:        [{ parte: String, gravedad: String, descripcion: String, costoEstimado: String }],
  resumenDanos: { type: String, default: '' },
  gravedad:     { type: String, enum: ['LEVE', 'MODERADO', 'GRAVE', 'TOTAL'], default: 'LEVE' },
  costoTotal:   { type: String, default: '' },
  // Estado del peritaje
  estado:       { type: String, enum: ['pendiente', 'revisando', 'aprobado', 'rechazado'], default: 'pendiente' },
  observaciones:{ type: String, default: '' },
  rawResponse:  { type: String, default: '' },
  createdAt:    { type: Date, default: Date.now },
});

module.exports = mongoose.model('Peritaje', peritajeSchema);
