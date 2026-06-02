// api/solis-produccion.js
// Función serverless para obtener datos de producción del inversor Solis
// Autenticación: HMAC-SHA1 según documentación SolisCloud API V2.0

const crypto = require('crypto');

const SOLIS_API_URL = 'https://www.soliscloud.com:13333';
const API_ID     = process.env.SOLIS_API_ID;
const API_SECRET = process.env.SOLIS_API_SECRET;

function getGMTDate() {
  return new Date().toUTCString().replace('UTC', 'GMT');
}

function getContentMD5(body) {
  return crypto.createHash('md5').update(body).digest('base64');
}

function getAuthorization(contentMD5, contentType, date, path) {
  const stringToSign = `POST\n${contentMD5}\n${contentType}\n${date}\n${path}`;
  const sign = crypto
    .createHmac('sha1', API_SECRET)
    .update(stringToSign)
    .digest('base64');
  return `API ${API_ID}:${sign}`;
}

async function solisPost(path, body) {
  const bodyStr = JSON.stringify(body);
  const contentType = 'application/json;charset=UTF-8';
  const date = getGMTDate();
  const contentMD5 = getContentMD5(bodyStr);
  const authorization = getAuthorization(contentMD5, contentType, date, path);

  const res = await fetch(`${SOLIS_API_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'Content-MD5': contentMD5,
      'Date': date,
      'Authorization': authorization
    },
    body: bodyStr
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  
  const json = JSON.parse(text);
  if (!json.success) throw new Error(`Solis error: ${json.msg || JSON.stringify(json)}`);
  return json.data;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!API_ID || !API_SECRET) {
    return res.status(500).json({ ok: false, error: 'Variables SOLIS_API_ID / SOLIS_API_SECRET no configuradas' });
  }

  try {
    const { tipo = 'lista', fecha } = req.query;

    if (tipo === 'lista') {
      const data = await solisPost('/v1/api/inverterList', { pageNo: '1', pageSize: '10' });
      const inversores = (data.page?.records || []).map(inv => ({
        id: inv.id,
        sn: inv.sn,
        nombre: inv.collectorName || inv.sn,
        potenciaInstalada: inv.power,
        estado: inv.state,
        energiaHoy: inv.eToday,
        energiaTotal: inv.eTotal
      }));
      return res.status(200).json({ ok: true, inversores });
    }

    // Para hoy/mes: obtener el primer inversor
    const listaData = await solisPost('/v1/api/inverterList', { pageNo: '1', pageSize: '10' });
    const records = listaData.page?.records || [];
    if (records.length === 0) {
      return res.status(200).json({ ok: false, error: 'No se encontraron inversores' });
    }
    const inv = records[0];

    if (tipo === 'hoy') {
      const hoy = fecha || new Date().toISOString().slice(0, 10);
      const data = await solisPost('/v1/api/inverterDay', {
        id: inv.id,
        sn: inv.sn,
        money: 'EUR',
        time: hoy,
        timeZone: '2'
      });
      return res.status(200).json({
        ok: true,
        tipo: 'hoy',
        fecha: hoy,
        sn: inv.sn,
        energiaHoy_kwh: parseFloat(inv.eToday) || 0,
        potenciaActual_kw: parseFloat(inv.power) || 0,
        puntos: (data.records || []).map(p => ({
          ts: p.dataTimestamp,
          pac_kw: parseFloat(p.pac) || 0,
          eHoy_kwh: parseFloat(p.eToday) || 0
        }))
      });
    }

    if (tipo === 'mes') {
      const mes = fecha || new Date().toISOString().slice(0, 7);
      const data = await solisPost('/v1/api/inverterMonth', {
        id: inv.id,
        sn: inv.sn,
        money: 'EUR',
        month: mes
      });
      return res.status(200).json({
        ok: true,
        tipo: 'mes',
        mes,
        sn: inv.sn,
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
