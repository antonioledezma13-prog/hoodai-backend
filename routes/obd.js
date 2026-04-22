const router    = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const auth      = require('../middleware/auth');
const checkUsos = require('../middleware/checkUsos');
const Vehicle   = require('../models/Vehicle');
const Scan      = require('../models/Scan');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── PIDs estándar OBD-II ──────────────────────────────────────────────────
const PID_MAP = {
  '0104':{ nombre:'Carga del motor',             unidad:'%',   formula:(A)   =>(A*100/255).toFixed(1) },
  '0105':{ nombre:'Temperatura del refrigerante',unidad:'°C',  formula:(A)   =>A-40 },
  '010A':{ nombre:'Presión del combustible',     unidad:'kPa', formula:(A)   =>A*3 },
  '010B':{ nombre:'Presión del colector',        unidad:'kPa', formula:(A)   =>A },
  '010C':{ nombre:'RPM del motor',               unidad:'RPM', formula:(A,B) =>((A*256+B)/4).toFixed(0) },
  '010D':{ nombre:'Velocidad del vehículo',      unidad:'km/h',formula:(A)   =>A },
  '010F':{ nombre:'Temperatura de admisión',     unidad:'°C',  formula:(A)   =>A-40 },
  '0110':{ nombre:'Flujo de masa de aire',       unidad:'g/s', formula:(A,B) =>((A*256+B)/100).toFixed(2) },
  '0111':{ nombre:'Posición del acelerador',     unidad:'%',   formula:(A)   =>(A*100/255).toFixed(1) },
  '011F':{ nombre:'Tiempo de marcha',            unidad:'min', formula:(A,B) =>((A*256+B)/60).toFixed(0) },
  '012F':{ nombre:'Nivel de combustible',        unidad:'%',   formula:(A)   =>(A*100/255).toFixed(1) },
  '0142':{ nombre:'Voltaje de la batería',       unidad:'V',   formula:(A,B) =>((A*256+B)/1000).toFixed(2) },
  '015C':{ nombre:'Temperatura del aceite',      unidad:'°C',  formula:(A)   =>A-40 },
};

// ── DTC estándar ECM ──────────────────────────────────────────────────────
const DTC_MAP = {
  'P0100':'Sensor MAF — circuito defectuoso',
  'P0101':'Sensor MAF — fuera de rango',
  'P0110':'Sensor temperatura admisión — falla',
  'P0115':'Sensor temperatura refrigerante — falla',
  'P0120':'Sensor posición acelerador — falla',
  'P0125':'Temperatura insuficiente para control de combustible',
  'P0130':'Sensor O2 — circuito defectuoso (banco 1)',
  'P0171':'Sistema demasiado pobre — banco 1',
  'P0172':'Sistema demasiado rico — banco 1',
  'P0190':'Sensor presión riel combustible — falla',
  'P0200':'Circuito del inyector — falla',
  'P0300':'Falla de encendido aleatoria',
  'P0301':'Falla de encendido — cilindro 1',
  'P0302':'Falla de encendido — cilindro 2',
  'P0303':'Falla de encendido — cilindro 3',
  'P0304':'Falla de encendido — cilindro 4',
  'P0320':'Señal posición cigüeñal — falla',
  'P0325':'Sensor detonación — falla',
  'P0335':'Sensor posición cigüeñal — sin señal',
  'P0340':'Sensor posición árbol de levas — falla',
  'P0400':'Sistema EGR — falla',
  'P0420':'Eficiencia catalizador por debajo del umbral — banco 1',
  'P0440':'Sistema EVAP — falla',
  'P0442':'Pequeña fuga detectada en sistema EVAP',
  'P0455':'Gran fuga detectada en sistema EVAP',
  'P0500':'Sensor velocidad vehículo — falla',
  'P0505':'Control de marcha mínima — falla',
  'P0562':'Voltaje bajo del sistema',
  'P0563':'Voltaje alto del sistema',
  'P0600':'Falla comunicación red CAN',
  'P0606':'Falla interna ECM',
  'P0700':'Falla en sistema de control de transmisión',
  'P0740':'Solenoide lock-up convertidor de par — falla',
};

// ── Etiquetas de módulos extendidos ───────────────────────────────────────
const MODULE_LABEL = {
  TCM:  'TRANSMISIÓN (TCM @ 7E1)',
  ABS:  'FRENOS / DIRECCIÓN ABS/EPS (@ 7E2)',
  BODY: 'CARROCERÍA BCM (@ 7E3)',
};

function translatePID(pid, hexBytes) {
  const info = PID_MAP[pid.toUpperCase()];
  if (!info) return null;
  const bytes = hexBytes.trim().split(' ').map(b=>parseInt(b,16)).filter(n=>!isNaN(n));
  if (bytes.length===0) return null;
  const valor = info.formula(bytes[0], bytes[1]||0, bytes[2]||0);
  return { nombre:info.nombre, valor, unidad:info.unidad };
}

function decodeDTC(hexBytes) {
  const bytes = hexBytes.trim().split(' ').map(b=>parseInt(b,16)).filter(n=>!isNaN(n));
  const codes = [];
  for (let i=0; i<bytes.length-1; i+=2) {
    if (bytes[i]===0&&bytes[i+1]===0) continue;
    const first=bytes[i], second=bytes[i+1];
    const type=['P','C','B','U'][(first>>6)&0x03];
    const d1=(first>>4)&0x03, d2=first&0x0F;
    const d34=second.toString(16).padStart(2,'0').toUpperCase();
    const code=`${type}${d1}${d2}${d34}`;
    codes.push({ code, descripcion:DTC_MAP[code]||'Código no identificado' });
  }
  return codes;
}

// ── POST /api/obd/analizar ────────────────────────────────────────────────
router.post('/analizar', auth, checkUsos, async (req, res) => {
  try {
    const {
      vehicleId,
      lecturas,        // [{ pid, hex }]
      codigosDTC,      // string hex raw — DTCs modo 03
      dtcPendientes,   // string hex raw — DTCs modo 07
      uCodes,          // string hex raw — UDS 19 02 FF (fallas de red CAN / U-codes)
      lecturasExt,     // [{ nombre, valor, modulo }]
      dtcExtendidos,   // [{ code, descripcion, modulo }] — ya decodificados por el frontend
      adapterType,
      freezeFrame,     // { dtcDisparador, frameNum, lecturas:[{ pid, nombre, valor, unidad }] }
    } = req.body;

    if (!lecturas && !codigosDTC && !lecturasExt && !dtcExtendidos)
      return res.status(400).json({ error:'Se requieren lecturas OBD o códigos DTC' });

    // Contexto del vehículo
    let vehicleContext='', vehicle=null;
    if (vehicleId) {
      vehicle = await Vehicle.findOne({ _id:vehicleId, userId:req.user._id });
      if (vehicle)
        vehicleContext=`${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.engine?' '+vehicle.engine:''}`;
    }

    // Traducir PIDs
    const lecturasTrad = (lecturas||[]).map(l=>{
      const trad=translatePID(l.pid,l.hex);
      return trad?`${trad.nombre}: ${trad.valor} ${trad.unidad}`:`PID ${l.pid}: ${l.hex}`;
    });

    // Decodificar DTC estándar ECM
    const dtcDecodificados   = codigosDTC    ? decodeDTC(codigosDTC)    : [];
    const dtcPendientesDecod = dtcPendientes ? decodeDTC(dtcPendientes) : [];
    const dtcHistorialDecod  = req.body.dtcHistorial ? decodeDTC(req.body.dtcHistorial) : [];

    // ── Decodificar U-codes (fallas de red CAN) ───────────────────────────
    // U0xxx = pérdida de comunicación entre módulos
    // Críticos: U0100 (ECM), U0121 (ABS), U0140 (BCM), U0155 (Cuadro), U0164 (HVAC)
    const U_CODE_MAP = {
      'U0001':'Bus CAN de alta velocidad — falla de comunicación general',
      'U0010':'Bus CAN de velocidad media — falla de comunicación',
      'U0100':'Sin comunicación con ECM/PCM — posible falla de módulo o bus CAN',
      'U0101':'Sin comunicación con TCM — transmisión sin respuesta en red',
      'U0114':'Sin comunicación con módulo de tracción en 4 ruedas (4WD/AWD)',
      'U0121':'Sin comunicación con módulo ABS — sistema de frenos comprometido',
      'U0122':'Sin comunicación con módulo de control de estabilidad (ESC/VSC)',
      'U0126':'Sin comunicación con módulo de dirección (EPS/AFS)',
      'U0131':'Sin comunicación con módulo de dirección asistida eléctrica',
      'U0140':'Sin comunicación con BCM — carrocería/luces/cierre sin respuesta',
      'U0141':'Sin comunicación con BCM auxiliar',
      'U0146':'Sin comunicación con módulo Gateway — pasarela CAN bloqueada',
      'U0151':'Sin comunicación con módulo SRS — airbags sin respuesta en red',
      'U0155':'Sin comunicación con cuadro de instrumentos (Cluster)',
      'U0164':'Sin comunicación con módulo HVAC — climatización sin respuesta',
      'U0184':'Sin comunicación con módulo de radio/audio',
      'U0401':'Datos inválidos recibidos del ECM/PCM — señal corrupta en bus',
      'U0415':'Datos inválidos recibidos del módulo ABS',
      'U0422':'Datos inválidos recibidos del BCM',
    };

    const uCodesDecod = [];
    if (uCodes && uCodes.length > 4) {
      // Parsear hex UDS 59 02 FF response: byte 3 = num DTCs, luego 4 bytes por DTC
      const bytes = uCodes.replace(/\s/g,'').match(/.{1,2}/g)||[];
      // Buscar el patrón de respuesta positiva UDS 59 02
      const startIdx = bytes.findIndex((b,i) => b.toUpperCase()==='59' && bytes[i+1]?.toUpperCase()==='02');
      if (startIdx >= 0) {
        const numDtc = parseInt(bytes[startIdx+3]||'0', 16);
        for (let i=0; i<numDtc && i<20; i++) {
          const base = startIdx + 4 + (i*4);
          if (base+1 < bytes.length) {
            const hi = parseInt(bytes[base],   16);
            const lo = parseInt(bytes[base+1], 16);
            const type = (hi>>6)&0x03;
            const d1   = (hi>>4)&0x03;
            const d2   = hi&0x0F;
            const d34  = lo.toString(16).padStart(2,'0').toUpperCase();
            const prefix = ['P','C','B','U'][type];
            const code   = `${prefix}${d1}${d2}${d34}`;
            const desc   = U_CODE_MAP[code] || `${code} — falla de comunicación en red CAN`;
            if (prefix === 'U') {
              uCodesDecod.push({ code, descripcion: desc, modulo: 'RED', urgencia: 'No manejar' });
            }
          }
        }
      }
    }

    // ── Bloques del prompt ────────────────────────────────────────────────

    const resumenLecturas = lecturasTrad.length>0
      ? `LECTURAS EN TIEMPO REAL (ECM — Motor):\n${lecturasTrad.join('\n')}`
      : '';

    const resumenDTC = dtcDecodificados.length>0
      ? `CÓDIGOS DE FALLA ECM (Motor):\n${dtcDecodificados.map(d=>`  ${d.code}: ${d.descripcion}`).join('\n')}`
      : 'Sin códigos de falla activos en ECM.';

    // U-codes en el prompt — sección separada con énfasis crítico
    let resumenUCodes = '';
    if (uCodesDecod.length > 0) {
      resumenUCodes = `FALLAS DE RED CAN (U-codes) — CRÍTICO:\n` +
        `(Estos códigos indican que módulos clave no se están comunicando entre sí.)\n` +
        `(Un vehículo con U-codes activos puede no arrancar aunque el ECM no muestre fallas P.)\n` +
        uCodesDecod.map(u=>`  ${u.code}: ${u.descripcion}`).join('\n');
    }

    // Sensores extendidos agrupados por módulo
    let resumenSensoresExt = '';
    if (Array.isArray(lecturasExt) && lecturasExt.length>0) {
      const grupos={};
      lecturasExt.forEach(l=>{ const m=l.modulo||'Extendido'; if(!grupos[m])grupos[m]=[]; grupos[m].push(`  ${l.nombre}: ${l.valor}`); });
      resumenSensoresExt = Object.entries(grupos)
        .map(([mod,lines])=>{
          const label=
            mod==='TCM'    ? 'TRANSMISIÓN (TCM @ 7E1)'          :
            mod==='ABS/EPS'? 'FRENOS / DIRECCIÓN ABS/EPS (@ 7E2)':
            mod==='BCM'    ? 'CARROCERÍA BCM (@ 7E3)'            :
            mod==='SRS'    ? 'AIRBAGS / SEGURIDAD SRS (@ 7E5)'   : mod;
          return `${label}:\n${lines.join('\n')}`;
        }).join('\n\n');
    }

    // DTC extendidos agrupados por módulo
    let resumenDTCExt = '';
    if (Array.isArray(dtcExtendidos) && dtcExtendidos.length>0) {
      const grupos={};
      dtcExtendidos.forEach(d=>{ const m=d.modulo||'Extendido'; if(!grupos[m])grupos[m]=[]; grupos[m].push(`  ${d.code}: ${d.descripcion}`); });
      resumenDTCExt = Object.entries(grupos)
        .map(([mod,lines])=>{
          const label=MODULE_LABEL[mod]||`MÓDULO ${mod}`;
          return `CÓDIGOS DE FALLA ${label}:\n${lines.join('\n')}`;
        }).join('\n\n');
    }

    const adapterLevel = adapterType && adapterType!=='GENERIC_ELM327'
      ? `Hardware: ${adapterType} — datos incluyen módulos extendidos (TCM, ABS/EPS, BCM).`
      : 'Hardware: adaptador básico — solo datos ECM/OBD-II disponibles.';

    const systemPrompt = [
      'Eres el Asesor Mecánico IA de HoodAI, experto en diagnóstico OBD-II para el mercado latinoamericano.',
      'Analiza los datos de la computadora del vehículo y explica las fallas en lenguaje simple y amigable.',
      vehicleContext?`Vehículo: ${vehicleContext}`:'',
      adapterLevel,
      'FORMATO OBLIGATORIO: Responde SOLO en texto plano. Sin asteriscos, sin guiones, sin negritas, sin markdown.',
      'Tono: calmado, pedagógico, como un mecánico de confianza.',
      'Si hay datos de transmisión, ABS, EPS o carrocería, inclúyelos en el análisis con la misma claridad.',
      'Cuando haya DTC de múltiples módulos, explica cada sistema afectado por separado en el campo "fallas".',
      'IMPORTANTE — U-CODES (RED CAN): Si hay fallas U0xxx, son CRÍTICAS. Significan que los módulos no se hablan entre sí. Un vehículo con U-codes puede no arrancar aunque el ECM diga que está bien. Siempre marca gravedad CRITICO y necesita_grua true si hay U-codes activos.',
      'IMPORTANTE — SRS/AIRBAGS: Si hay fallas en el módulo SRS, márcalas siempre como urgencia "No manejar" y explica que el sistema de protección puede estar comprometido.',
      'IMPORTANTE — SIN DTC PERO NO ARRANCA: Si el ECM no reporta fallas pero el vehículo tiene síntomas graves, busca U-codes de red, verifica tensión de batería y considera falla de sensor CKP/CMP o relé de combustible.',
    ].filter(Boolean).join('\n');

    // Freeze Frame
    let resumenFreezeFrame = '';
    if (freezeFrame && Array.isArray(freezeFrame.lecturas) && freezeFrame.lecturas.length > 0) {
      const lineas = freezeFrame.lecturas.map(l => `  ${l.nombre}: ${l.valor} ${l.unidad}`);
      resumenFreezeFrame =
        `FREEZE FRAME — Estado del motor cuando se generó ${freezeFrame.dtcDisparador}:\n` +
        `(Estos valores son exactamente como estaba el motor en el momento de la falla)\n` +
        lineas.join('\n');
    }

    const bloques = [resumenLecturas, resumenDTC, resumenUCodes, resumenSensoresExt, resumenDTCExt, resumenFreezeFrame].filter(Boolean).join('\n\n');

    const userMessage = `Analiza estos datos de la computadora del vehículo y dime en lenguaje común qué está pasando, qué tan grave es y qué debo hacer:\n\n${bloques}\n\nResponde SOLO con este JSON sin markdown:\n{\n  "gravedad": "NORMAL|PRECAUCION|CRITICO",\n  "resumen": "Explicación amigable en 2-3 oraciones sin tecnicismos",\n  "fallas": [\n    { "codigo": "PXXXX|UXXXX|CXXXX|BXXXX", "nombre": "nombre simple", "explicacion": "explicación en palabras simples", "urgencia": "Puede esperar|Ir al taller pronto|No manejar", "modulo": "ECM|TCM|ABS|BODY|RED" }\n  ],\n  "lecturas": [\n    { "nombre": "nombre", "valor": "valor con unidad", "estado": "normal|alerta|critico" }\n  ],\n  "recomendacion": "Qué debe hacer el conductor ahora mismo",\n  "necesita_grua": false\n}`;

    const message = await client.messages.create({
      model:      'claude-opus-4-6',
      max_tokens: 1200,
      system:     systemPrompt,
      messages:   [{ role:'user', content:userMessage }],
    });

    const rawText = message.content[0].text.trim();
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g,'').trim());
    } catch {
      const todasFallas=[...dtcDecodificados,...uCodesDecod,...(Array.isArray(dtcExtendidos)?dtcExtendidos:[])];
      parsed = {
        gravedad: uCodesDecod.length>0 ? 'CRITICO' : 'PRECAUCION',
        resumen:rawText,
        fallas:todasFallas.map(d=>({ codigo:d.code, nombre:d.code, explicacion:d.descripcion, urgencia: d.modulo==='RED'?'No manejar':'Ir al taller pronto', modulo:d.modulo||'ECM' })),
        lecturas:[], recomendacion:'Consulta con un mecánico de confianza.', necesita_grua: uCodesDecod.length>0,
      };
    }

    // Guardar escaneo
    await Scan.create({
      userId:      req.user._id,
      vehicleId:   vehicle?._id,
      thumbnail:   '',
      parts:       (parsed.fallas||[]).map(f=>({
        name:        f.codigo,
        status:      f.urgencia==='No manejar'?'critical':'warning',
        description: f.explicacion,
        module:      f.modulo||'ECM',
      })),
      summary:     parsed.resumen||'',
      rawResponse: rawText,
    });

    await req.user.consumirUso();

    res.json({
      ...parsed,
      dtcDecodificados,
      dtcPendientesDecod,
      dtcHistorialDecod,
      uCodesDecod,
      lecturasTrad: (lecturas||[]).map(l=>translatePID(l.pid,l.hex)).filter(Boolean),
      usosRestantes: req.user.usosRestantes + req.user.usosExtra,
    });

  } catch(e) {
    console.error('OBD analyze error:', e);
    res.status(500).json({ error:e.message });
  }
});

module.exports = router;
