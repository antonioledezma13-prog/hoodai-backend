/**
 * GET /api/carbg?url=<encoded_image_url>
 *
 * Descarga la imagen del vehículo (Wikipedia/Wikimedia),
 * la envía a remove.bg para eliminar el fondo,
 * devuelve el PNG con fondo transparente en base64.
 *
 * Requiere: REMOVEBG_API_KEY en .env
 * Plan gratuito remove.bg: 50 imágenes/mes
 * https://www.remove.bg/api
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const https  = require('https');
const http   = require('http');
const FormData = require('form-data');

// Descarga una URL como Buffer
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'HoodAI/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} al descargar imagen`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Envía el buffer a remove.bg y devuelve PNG transparente como Buffer
function removeBackground(imgBuffer, filename) {
  return new Promise((resolve, reject) => {
    if (!process.env.REMOVEBG_API_KEY) {
      return reject(new Error('REMOVEBG_API_KEY no configurada'));
    }

    const form = new FormData();
    form.append('image_file', imgBuffer, { filename: filename || 'car.jpg', contentType: 'image/jpeg' });
    form.append('size', 'auto');
    form.append('type', 'car');   // hint: es un carro
    form.append('format', 'png');

    const options = {
      hostname: 'api.remove.bg',
      path: '/v1.0/removebg',
      method: 'POST',
      headers: {
        'X-Api-Key': process.env.REMOVEBG_API_KEY,
        ...form.getHeaders(),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(Buffer.concat(chunks));
        } else {
          const body = Buffer.concat(chunks).toString();
          reject(new Error(`remove.bg error ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

// Cache simple en memoria (evita repetir la misma imagen)
const cache = new Map();
const CACHE_MAX = 50; // máx entradas en cache

router.get('/', auth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Falta parámetro url' });

  // Validar que sea una URL de Wikipedia/Wikimedia
  const decodedUrl = decodeURIComponent(url);
  const allowed = ['wikipedia.org', 'wikimedia.org', 'upload.wikimedia.org'];
  const isAllowed = allowed.some(d => decodedUrl.includes(d));
  if (!isAllowed) return res.status(403).json({ error: 'URL no permitida' });

  // Revisar cache
  if (cache.has(decodedUrl)) {
    const cached = cache.get(decodedUrl);
    return res.json({ png: cached, cached: true });
  }

  try {
    // 1. Descargar imagen de Wikipedia
    const imgBuffer = await downloadBuffer(decodedUrl);

    // 2. Eliminar fondo con remove.bg
    const pngBuffer = await removeBackground(imgBuffer, 'vehicle.jpg');

    // 3. Convertir a base64
    const base64 = pngBuffer.toString('base64');

    // 4. Guardar en cache
    if (cache.size >= CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(decodedUrl, base64);

    res.json({ png: base64, cached: false });

  } catch (e) {
    console.error('[carbg]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
