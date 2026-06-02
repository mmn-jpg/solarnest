// api/solis-produccion.js
// Función serverless para obtener datos de producción del inversor Solis
// Autenticación: HMAC-SHA1 según documentación SolisCloud API V2.0

const crypto = require('crypto');

const SOLIS_API_URL = 'https://www.soliscloud.com:13333';
const API_ID  = process.env.SOLIS_API_ID;
const API_SECRET = process.env.SOLIS_API_SECRET;

// Genera los headers de autenticación requeridos por SolisCloud
function buildHeaders(path, body) {
  const bodyStr = JSON.stringify(body);

  // Content-MD5: MD5 del body en Base64
  const contentMD5 = crypto
    .createHash('md5')
    .update(bodyStr)
    .digest('base64');

  const contentType = 'application/json;charset=UTF-8';

  // Date en formato GMT exacto que requiere Solis
  const date = new Date().toUTCString().replace(/GMT$/, '+0000').replace(/\+0000$/, 'GMT');
  const gmtDate = new Date().toUTCString();

  // Firma HMAC-SHA1
  const signStr = `POST\n${contentMD5}\n${contentType}\n${gmtDate}\n${path}`;
  const sign = crypto
    .createHmac('sha1', API_SECRET)
    .update(signStr)
    .digest('base64');

  return {
    'Content-Type': contentType,
    'Content-MD5': contentMD5,
    'Date': gmtDate,
    'Authorization': `API ${API_ID}:${sign}`
  };
}

async function solisPost(path, body) {
  const headers = buildHeaders(path, body);
  const res = await fetch(`${SOLIS_API_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.msg || 'Solis API error');
  return json.data;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!API_ID || !API_SECRET) {
    return res.status(500).json({ ok: false, error: 'Variables de entorno SOLIS_API_ID / SOLIS_API_SECRET no configuradas' });
  }

  try {
    const { tipo = 'hoy', fecha } = req.query;
    // tipo: 'hoy' → producción del día actual
    //       'mes' → producción diaria del mes indicado (YYYY/MM)
    //       'lista' → lista de inversores (para obtener el ID)

    if (tipo === 'lista') {
      // Paso 1: obtener lista de inversores para conocer el ID
      const data = await solisPost('/v1/api/inverterList', { pageNo: '1', pageSize: '10' });
      const inversores = (data.page?.records || []).map(inv => ({
        id: inv.id,
        sn: inv.sn,
        nombre: inv.collectorName || inv.sn,
        potencia: inv.power,
        estado: inv.state
      }));
      return res.status(200).json({ ok: true, inversores });
    }

    // Para 'hoy' y 'mes' necesitamos el ID del inversor
    // Primero lo obtenemos automáticamente
    const listaData = await solisPost('/v1/api/inverterList', { pageNo: '1', pageSize: '10' });
    const records = listaData.page?.records || [];
    if (records.length === 0) {
      return res.status(200).json({ ok: false, error: 'No se encontraron inversores en la cuenta' });
    }
    const inversor = records[0]; // tomamos el primero (Miguel tiene 1 inversor)
    const inverterId = inversor.id;
    const inverterSn = inversor.sn;

    if (tipo === 'hoy') {
      // Producción horaria del día actual
      const hoy = fecha || new Date().toISOString().slice(0, 10).replace(/-/g, '-');
      const [y, m, d] = hoy.split('-');
      const data = await solisPost('/v1/api/inverterDay', {
        inverterId,
        sn: inverterSn,
        money: 'EUR',
        time: `${y}-${m}-${d}`,
        timeZone: '2' // Europa Central (CET = UTC+1, CEST = UTC+2)
      });
      // Devolvemos los puntos de energía cada 5min
      return res.status(200).json({
        ok: true,
        tipo: 'hoy',
        fecha: `${y}-${m}-${d}`,
        inverterSn,
        energia_hoy_kwh: parseFloat(inversor.eToday) || 0,
        potencia_actual_kw: parseFloat(inversor.power) || 0,
        puntos: (data.records || []).map(p => ({
          hora: p.dataTimestamp,
          potencia_kw: parseFloat(p.pac) || 0,
          energia_acum_kwh: parseFloat(p.eToday) || 0
        }))
      });
    }

    if (tipo === 'mes') {
      // Producción diaria del mes indicado (YYYY-MM)
      const mes = fecha || new Date().toISOString().slice(0, 7); // '2026-06'
      const data = await solisPost('/v1/api/inverterMonth', {
        inverterId,
        sn: inverterSn,
        money: 'EUR',
        month: mes // formato YYYY-MM
      });
      return res.status(200).json({
        ok: true,
        tipo: 'mes',
        mes,
        inverterSn,
        dias: (data.records || []).map(d => ({
          fecha: d.date,
          energia_kwh: parseFloat(d.energy) || 0
        }))
      });
    }

    return res.status(400).json({ ok: false, error: 'tipo no válido. Usa: lista, hoy, mes' });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
