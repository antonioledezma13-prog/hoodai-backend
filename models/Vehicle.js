const mongoose = require('mongoose');

const vehicleSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  make:    { type: String, required: true },   // Toyota
  model:   { type: String, required: true },   // Corolla
  year:    { type: Number, required: true },
  engine:  { type: String },                   // 1.8L 2ZR-FE
  vin:     { type: String },
  nickname:{ type: String },                   // "Mi Corolla"
  createdAt:{ type: Date, default: Date.now },
});

module.exports = mongoose.model('Vehicle', vehicleSchema);
