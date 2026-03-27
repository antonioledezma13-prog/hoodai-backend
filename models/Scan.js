const mongoose = require('mongoose');

const partSchema = new mongoose.Schema({
  name:       String,
  status:     { type: String, enum: ['ok', 'warning', 'critical', 'unknown'] },
  description:String,
  action:     String,
  estimatedCost: String,
  confidence: Number,
}, { _id: false });

const scanSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
  thumbnail: { type: String },           // base64 small preview
  parts:     [partSchema],
  summary:   { type: String },
  rawResponse:{ type: String },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Scan', scanSchema);
