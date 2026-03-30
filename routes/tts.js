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

    // Limitar longitud para no gastar créditos en textos muy largos
    const textLimited = text.slice(0, 500);

    if (!ELEVENLABS_API_KEY)
      return res.status(500).json({ error: 'ElevenLabs no configurado en el servidor' });

    // Limpiar markdown antes de enviar a ElevenLabs
    const cleanText = textLimited
      .replace(/\*\*(.*?)\*\*/g, '$1')   // **negrita**
      .replace(/\*(.*?)\*/g, '$1')       // *cursiva*
      .replace(/#{1,6}\s/g, '')          // # encabezados
      .replace(/`{1,3}[^`]*`{1,3}/g, '') // `código`
      .replace(/\[(.*?)\]\(.*?\)/g, '$1') // [links](url)
      .replace(/[-•]\s/g, '')            // listas con guión o bullet
      .replace(/\n{2,}/g, '. ')          // saltos dobles → pausa
      .replace(/\n/g, ' ')              // saltos simples → espacio
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
