// =============================================================
//  SolarNest · Consumo real desde Datadis (con caché compartida en Redis)
//  Pide tu consumo horario a Datadis y lo resume por días.
//
//  Uso:
//   /api/datadis-consumo                 -> mes actual
//   /api/datadis-consumo?mes=2026/04     -> un mes concreto (AAAA/MM)
//   /api/datadis-consumo?mes=2026/04&forzar=1 -> ignora caché y pide a Datadis
//
//  Credenciales: variables de entorno DATADIS_USER y DATADIS_PASS
//
//  CACHÉ COMPARTIDA (Upstash Redis):
//   Para que TODOS los dispositivos compartan los datos y Datadis se consulte
//   una sola vez al día (en vez de una por dispositivo, que disparaba el 429),
//   guardamos cada mes en Redis. Cuando llega una petición:
//     1) Si Redis tiene ese mes y es reciente (<20h) -> se devuelve al instante.
//     2) Si no, se consulta a Datadis, se guarda en Redis y se devuelve.
//     3) Si Datadis da 429 pero hay algo en Redis (aunque sea viejo) -> se
//        devuelve lo de Redis para no dejar al usuario sin datos.
//   Variables de entorno (las crea sola la integración de Upstash en Vercel):
//     KV_REST_API_URL y KV_REST_API_TOKEN
// =============================================================

const CUPS = 'ES0031408041899001FT0F'; // tu suministro
const DISTRIBUTOR = '2';               // E-distribución
const POINT_TYPE = '5';                // tipo de punto (doméstico habitual)

const CACHE_FRESH_MS = 20 * 3600 * 1000; // datos "frescos" si tienen menos de 20h

// ---------- Helpers de Redis (Upstash REST API) ----------
// Usamos la REST API de Upstash (HTTP), que funciona en funciones serverless.
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function redisGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    if (!r.ok) return null;
    const j = await r.json();
    // Upstash devuelve { result: "<valor o null>" }
    if (!j || j.result == null) return null;
    return JSON.parse(j.result);
  } catch (e) {
    return null;
  }
}

async function redisSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    // Guardamos como string JSON. POST con el cuerpo = valor.
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'text/plain'
      },
      body: JSON.stringify(value)
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

// Construye el objeto de respuesta a partir de los datos crudos de Datadis
function resumirDatos(datos, mes) {
  const porDia = {};      // dia -> total kWh (como hasta ahora)
  const horasPorDia = {}; // dia -> array(24) de kWh por hora, o null si Datadis no la ha publicado
  let totalMes = 0;
  for (const r of datos) {
    const kwh = Number(r.consumptionKWh) || 0;
    totalMes += kwh;
    const dia = r.date; // AAAA/MM/DD
    if (!porDia[dia]) porDia[dia] = 0;
    porDia[dia] += kwh;

    // Datadis usa convención "hora que termina el periodo": 01:00..24:00
    // El consumo etiquetado "01:00" corresponde a las 00:00-01:00 -> índice 0.
    if (!horasPorDia[dia]) horasPorDia[dia] = Array(24).fill(null);
    const h = parseInt(String(r.time || '').slice(0, 2), 10);
    if (!isNaN(h)) {
      let idx = null;
      if (h >= 1 && h <= 24) idx = (h - 1) % 24;       // convención 1-24 (la habitual en Datadis)
      else if (h >= 0 && h <= 23) idx = h;             // por si llega 0-23
      if (idx !== null) horasPorDia[dia][idx] = (horasPorDia[dia][idx] || 0) + kwh;
    }
  }
  const dias = Object.keys(porDia).sort().map(d => {
    const horas = horasPorDia[d] || Array(24).fill(null);
    const horasValidas = horas.filter(v => v !== null).length;
    return {
      dia: d,
      kwh: Number(porDia[d].toFixed(3)),
      horas: horas.map(v => v === null ? null : Number(v.toFixed(3))),
      horasValidas
    };
  });
  return {
    ok: true,
    mesConsultado: mes,
    registrosHorarios: datos.length,
    totalMesKWh: Number(totalMes.toFixed(2)),
    numeroDias: dias.length,
    primerRegistro: { fecha: datos[0].date, hora: datos[0].time, kwh: datos[0].consumptionKWh, metodo: datos[0].obtainMethod },
    consumoPorDia: dias
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const USER = process.env.DATADIS_USER;
  const PASS = process.env.DATADIS_PASS;
  if (!USER || !PASS) {
    return res.status(500).json({ ok: false, error: 'Faltan credenciales DATADIS_USER / DATADIS_PASS.' });
  }

  // Mes a consultar: por parámetro ?mes=AAAA/MM, o el mes actual por defecto
  let mes = (req.query && req.query.mes) ? String(req.query.mes) : null;
  if (!mes) {
    const hoy = new Date();
    mes = hoy.getFullYear() + '/' + String(hoy.getMonth() + 1).padStart(2, '0');
  }
  if (!/^\d{4}\/\d{2}$/.test(mes)) {
    return res.status(200).json({ ok: false, error: 'Formato de mes inválido. Usa AAAA/MM, p.ej. 2026/04.' });
  }

  const forzar = req.query && (req.query.forzar === '1' || req.query.forzar === 'true');
  const cacheKey = 'datadis:' + mes; // p.ej. "datadis:2026/05"

  // ---------- 1) Intentar servir desde la caché de Redis ----------
  let cacheGuardada = null;
  if (!forzar) {
    cacheGuardada = await redisGet(cacheKey);
    if (cacheGuardada && cacheGuardada.guardadoEn && cacheGuardada.datos) {
      const edad = Date.now() - cacheGuardada.guardadoEn;
      if (edad < CACHE_FRESH_MS) {
        // Datos frescos: los devolvemos sin tocar Datadis
        return res.status(200).json({ ...cacheGuardada.datos, _cache: 'fresca', _edadMin: Math.round(edad / 60000) });
      }
    }
  }

  // ---------- 2) Consultar a Datadis ----------
  try {
    const auth = await fetch('https://datadis.es/nikola-auth/tokens/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: USER, password: PASS }).toString()
    });
    if (!auth.ok) {
      // Si falla el login pero teníamos algo en caché (aunque viejo), lo damos
      if (cacheGuardada && cacheGuardada.datos) {
        return res.status(200).json({ ...cacheGuardada.datos, _cache: 'vieja', _motivo: 'login-fallido' });
      }
      return res.status(200).json({ ok: false, paso: 'login', httpStatus: auth.status,
        pista: 'No se pudo iniciar sesión en Datadis.' });
    }
    const token = (await auth.text()).trim();

    const url = 'https://datadis.es/api-private/api/get-consumption-data'
      + '?cups=' + encodeURIComponent(CUPS)
      + '&distributorCode=' + DISTRIBUTOR
      + '&startDate=' + encodeURIComponent(mes)
      + '&endDate=' + encodeURIComponent(mes)
      + '&measurementType=0'
      + '&pointType=' + POINT_TYPE;

    const cons = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    });

    if (!cons.ok) {
      const texto = await cons.text();
      // Si Datadis da error (429 u otro) pero teníamos caché vieja, la devolvemos
      if (cacheGuardada && cacheGuardada.datos) {
        return res.status(200).json({
          ...cacheGuardada.datos,
          _cache: 'vieja',
          _motivo: cons.status === 429 ? 'datadis-429' : 'datadis-error-' + cons.status
        });
      }
      return res.status(200).json({
        ok: false, paso: 'get-consumption-data', httpStatus: cons.status, mesConsultado: mes,
        pista: cons.status === 429
          ? 'Datadis bloquea repetir la misma consulta en 24h (error 429). Prueba con otro mes o espera.'
          : (cons.status === 500
            ? 'Error 500. Suele pasar justo en el mes de inicio de contrato. Prueba un mes anterior, p.ej. ?mes=2026/04.'
            : 'Datadis devolvió un error en la consulta de consumo.'),
        respuesta: texto.slice(0, 300)
      });
    }

    const datos = await cons.json(); // array de registros horarios

    if (!Array.isArray(datos) || datos.length === 0) {
      // Sin datos nuevos: si teníamos caché, la devolvemos; si no, mensaje vacío
      if (cacheGuardada && cacheGuardada.datos) {
        return res.status(200).json({ ...cacheGuardada.datos, _cache: 'vieja', _motivo: 'sin-datos-nuevos' });
      }
      return res.status(200).json({ ok: true, mesConsultado: mes, registros: 0,
        mensaje: 'Sin datos para ese mes (puede que aún no estén validados).' });
    }

    // ---------- 3) Resumir, guardar en Redis y devolver ----------
    const resultado = resumirDatos(datos, mes);
    // Solo guardamos en Redis si hay datos reales. Así evitamos cachear "mes vacío"
    // (Datadis puede devolver registros con 0 kWh para el mes en curso aún sin publicar),
    // lo que bloquearía las próximas 20h sirviendo ceros.
    if (resultado.totalMesKWh > 0 && resultado.consumoPorDia.length > 0) {
      redisSet(cacheKey, { guardadoEn: Date.now(), datos: resultado });
    }
    const cacheTag = resultado.totalMesKWh > 0 ? 'nueva' : 'vacia';
    return res.status(200).json({ ...resultado, _cache: cacheTag });

  } catch (e) {
    // Excepción de red: si hay caché vieja, mejor eso que un error
    if (cacheGuardada && cacheGuardada.datos) {
      return res.status(200).json({ ...cacheGuardada.datos, _cache: 'vieja', _motivo: 'excepcion' });
    }
    return res.status(200).json({ ok: false, paso: 'excepcion', error: String(e) });
  }
}
