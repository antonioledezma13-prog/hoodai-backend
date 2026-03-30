const router = require('express').Router();
const auth   = require('../middleware/auth');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID           = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // voz masculina española por defecto

// POST /api/tts — convierte texto a audio (solo plan gold)
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.plan !== 'gold')
      return res.status(403).json({ error: 'La voz IA está disponible solo en el Plan Oro' });

    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'text requerido' });

    if (!ELEVENLABS_API_KEY)
      return res.status(500).json({ error: 'ElevenLabs no configurado en el servidor' });

    // Limpieza agresiva de markdown antes de enviar a ElevenLabs
    const cleanText = text
      .slice(0, 500)
      .replace(/\*{1,3}(.*?)\*{1,3}/g, '$1')   // *x* **x** ***x***
      .replace(/\*/g, '')                        // cualquier * suelto restante
      .replace(/_{1,2}(.*?)_{1,2}/g, '$1')      // _x_ __x__
      .replace(/#{1,6}\s*/g, '')                 // # encabezados
      .replace(/`{1,3}[^`]*`{1,3}/g, '')        // `código`
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')        // [links](url)
      .replace(/^\s*[-•>]\s*/gm, '')             // listas y citas
      .replace(/^\s*\d+\.\s*/gm, '')             // listas numeradas
      .replace(/\n{2,}/g, '. ')                  // saltos dobles → pausa natural
      .replace(/\n/g, ' ')                       // saltos simples → espacio
      .replace(/\s{2,}/g, ' ')                   // espacios múltiples
      .trim();

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key':   ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept':       'audio/mpeg',
      },
      body: JSON.stringify({
        text: cleanText,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability:        0.4,
          similarity_boost: 0.85,
          style:            0.2,
          use_speaker_boost: true,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.detail?.message || 'Error ElevenLabs' });
    }

    // Devolver el audio como base64 para reproducirlo en el frontend
    const buffer     = await response.arrayBuffer();
    const base64     = Buffer.from(buffer).toString('base64');
    res.json({ audio: base64, format: 'audio/mpeg' });

  } catch (e) {
    console.error('TTS error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
