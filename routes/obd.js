const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const auth      = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const Vehicle   = require('../models/Vehicle');
const Scan      = require('../models/Scan');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Tabla de PIDs estándar OBD-II ────────────────────────────────────────
const PID_MAP = {
  '0104': { nombre: 'Carga del motor',          unidad: '%',   formula: (A) => (A * 100 / 255).toFixed(1) },
  '0105': { nombre: 'Temperatura del refrigerante', unidad: '°C', formula: (A) => A - 40 },
  '010A': { nombre: 'Presión del combustible',  unidad: 'kPa', formula: (A) => A * 3 },
  '010B': { nombre: 'Presión del colector',     unidad: 'kPa', formula: (A) => A },
  '010C': { nombre: 'RPM del motor',            unidad: 'RPM', formula: (A, B) => ((A * 256 + B) / 4).toFixed(0) },
  '010D': { nombre: 'Velocidad del vehículo',   unidad: 'km/h',formula: (A) => A },
  '010F': { nombre: 'Temperatura de admisión',  unidad: '°C',  formula: (A) => A - 40 },
  '0110': { nombre: 'Flujo de masa de aire',    unidad: 'g/s', formula: (A, B) => ((A * 256 + B) / 100).toFixed(2) },
  '0111': { nombre: 'Posición del acelerador',  unidad: '%',   formula: (A) => (A * 100 / 255).toFixed(1) },
  '011F': { nombre: 'Tiempo de marcha',         unidad: 'min', formula: (A, B) => ((A * 256 + B) / 60).toFixed(0) },
  '012F': { nombre: 'Nivel de combustible',     unidad: '%',   formula: (A) => (A * 100 / 255).toFixed(1) },
  '0142': { nombre: 'Voltaje de la batería',    unidad: 'V',   formula: (A, B) => ((A * 256 + B) / 1000).toFixed(2) },
  '015C': { nombre: 'Temperatura del aceite',   unidad: '°C',  formula: (A) => A - 40 },
};

// ── Tabla de códigos DTC comunes ─────────────────────────────────────────
const DTC_MAP = {
  'P0100': 'Sensor de flujo de masa de aire — circuito defectuoso',
  'P0101': 'Sensor MAF fuera de rango',
  'P0110': 'Sensor de temperatura de admisión — falla de circuito',
  'P0115': 'Sensor de temperatura del refrigerante — falla de circuito',
  'P0120': 'Sensor de posición del acelerador — falla',
  'P0125': 'Temperatura insuficiente para control de combustible',
  'P0130': 'Sensor de oxígeno — circuito defectuoso (banco 1)',
  'P0171': 'Sistema demasiado pobre — banco 1',
  'P0172': 'Sistema demasiado rico — banco 1',
  'P0190': 'Sensor de presión de riel de combustible — falla',
  'P0200': 'Circuito del inyector de combustible — falla',
  'P0300': 'Falla de encendido aleatoria detectada',
  'P0301': 'Falla de encendido — cilindro 1',
  'P0302': 'Falla de encendido — cilindro 2',
  'P0303': 'Falla de encendido — cilindro 3',
  'P0304': 'Falla de encendido — cilindro 4',
  'P0320': 'Señal de posición del cigüeñal — falla',
  'P0325': 'Sensor de detonación — falla de circuito',
  'P0335': 'Sensor de posición del cigüeñal — sin señal',
  'P0340': 'Sensor de posición del árbol de levas — falla',
  'P0400': 'Sistema de recirculación de gases de escape — falla',
  'P0420': 'Eficiencia del catalizador por debajo del umbral — banco 1',
  'P0440': 'Sistema de control de emisiones evaporativas — falla',
  'P0442': 'Pequeña fuga detectada en sistema EVAP',
  'P0455': 'Gran fuga detectada en sistema EVAP',
  'P0500': 'Sensor de velocidad del vehículo — falla',
  'P0505': 'Sistema de control de marcha mínima — falla',
  'P0562': 'Voltaje bajo del sistema eléctrico',
  'P0563': 'Voltaje alto del sistema eléctrico',
  'P0600': 'Falla de comunicación en red CAN',
  'P0606': 'Falla interna del módulo de control del motor (ECM)',
  'P0700': 'Falla en el sistema de control de transmisión',
  'P0740': 'Solenoide de bloqueo del convertidor de par — falla',
};

// ── Función para traducir hex a valor legible ────────────────────────────
function translatePID(pid, hexBytes) {
  const info = PID_MAP[pid.toUpperCase()];
  if (!info) return null;

  const bytes = hexBytes.trim().split(' ').map(b => parseInt(b, 16)).filter(n => !isNaN(n));
  if (bytes.length === 0) return null;

  const valor = info.formula(bytes[0], bytes[1] || 0, bytes[2] || 0);
  return { nombre: info.nombre, valor, unidad: info.unidad };
}

// ── Función para decodificar códigos DTC ────────────────────────────────
function decodeDTC(hexBytes) {
  const bytes = hexBytes.trim().split(' ').map(b => parseInt(b, 16)).filter(n => !isNaN(n));
  const codes = [];

  for (let i = 0; i < bytes.length - 1; i += 2) {
    if (bytes[i] === 0 && bytes[i+1] === 0) continue;
    const first = bytes[i];
    const second = bytes[i+1];
    const type = ['P', 'C', 'B', 'U'][(first >> 6) & 0x03];
    const digit1 = (first >> 4) & 0x03;
    const digit2 = first & 0x0F;
    const digit34 = second.toString(16).padStart(2, '0').toUpperCase();
    const code = `${type}${digit1}${digit2}${digit34}`;
    codes.push({ code, descripcion: DTC_MAP[code] || 'Código no identificado en base de datos' });
  }
  return codes;
}

// ── POST /api/obd/analizar ───────────────────────────────────────────────
router.post('/analizar', auth, checkUsos, async (req, res) => {
  try {
    const { vehicleId, lecturas, codigosDTC } = req.body;
    // lecturas: [{ pid: '010C', hex: '1A F8' }, ...]
    // codigosDTC: '43 01 33 00 00 ...' (respuesta raw del comando 03)

    if (!lecturas && !codigosDTC)
      return res.status(400).json({ error: 'Se requieren lecturas OBD o códigos DTC' });

    // Obtener contexto del vehículo
    let vehicleContext = '';
    let vehicle = null;
    if (vehicleId) {
      vehicle = await Vehicle.findOne({ _id: vehicleId, userId: req.user._id });
      if (vehicle) vehicleContext = `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.engine ? ' ' + vehicle.engine : ''}`;
    }

    // Traducir lecturas PID
    const lecturasTrad = (lecturas || []).map(l => {
      const trad = translatePID(l.pid, l.hex);
      return trad ? `${trad.nombre}: ${trad.valor} ${trad.unidad}` : `PID ${l.pid}: ${l.hex}`;
    });

    // Decodificar códigos DTC
    const dtcDecodificados = codigosDTC ? decodeDTC(codigosDTC) : [];

    // Construir resumen para la IA
    const resumenLecturas = lecturasTrad.length > 0
      ? `LECTURAS EN TIEMPO REAL:\n${lecturasTrad.join('\n')}`
      : '';

    const resumenDTC = dtcDecodificados.length > 0
      ? `CÓDIGOS DE FALLA (DTC):\n${dtcDecodificados.map(d => `${d.code}: ${d.descripcion}`).join('\n')}`
      : 'Sin códigos de falla activos.';

    const systemPrompt = `Eres el Asesor Mecánico IA de HoodAI, experto en diagnóstico OBD-II para el mercado latinoamericano.
Analiza los datos de la computadora del vehículo y explica las fallas en lenguaje simple y amigable.
${vehicleContext ? `Vehículo: ${vehicleContext}` : ''}
FORMATO OBLIGATORIO: Responde SOLO en texto plano. Sin asteriscos, sin guiones, sin negritas, sin markdown de ningún tipo.
Tono: calmado, pedagógico, como un mecánico de confianza explicándole a un amigo.`;

    const userMessage = `Analiza estos datos de la computadora del vehículo y dime en lenguaje común qué está pasando, qué tan grave es y qué debo hacer:

${resumenLecturas}

${resumenDTC}

Responde SOLO con este JSON sin markdown:
{
  "gravedad": "NORMAL|PRECAUCION|CRITICO",
  "resumen": "Explicación amigable de qué está pasando con el carro en 2-3 oraciones sin tecnicismos",
  "fallas": [
    { "codigo": "P0XXX", "nombre": "nombre simple", "explicacion": "qué significa en palabras simples", "urgencia": "Puede esperar|Ir al taller pronto|No manejar" }
  ],
  "lecturas": [
    { "nombre": "nombre del dato", "valor": "valor con unidad", "estado": "normal|alerta|critico" }
  ],
  "recomendacion": "Qué debe hacer el conductor ahora mismo",
  "necesita_grua": false
}`;

    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const raw = message.content[0].text.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      parsed = {
        gravedad: 'PRECAUCION',
        resumen: raw,
        fallas: dtcDecodificados.map(d => ({ codigo: d.code, nombre: d.code, explicacion: d.descripcion, urgencia: 'Ir al taller pronto' })),
        lecturas: [],
        recomendacion: 'Consulta con un mecánico de confianza.',
        necesita_grua: false,
      };
    }

    // Guardar en historial de escaneos
    await Scan.create({
      userId:    req.user._id,
      vehicleId: vehicle?._id,
      thumbnail: '',
      parts:     parsed.fallas?.map(f => ({ name: f.codigo, status: f.urgencia === 'No manejar' ? 'critical' : 'warning', description: f.explicacion })) || [],
      summary:   parsed.resumen || '',
      rawResponse: raw,
    });

    await req.user.consumirUso();

    res.json({
      ...parsed,
      dtcDecodificados,
      lecturasTrad: (lecturas || []).map(l => translatePID(l.pid, l.hex)).filter(Boolean),
      usosRestantes: req.user.usosRestantes + req.user.usosExtra,
    });

  } catch (e) {
    console.error('OBD analyze error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
