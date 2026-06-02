// api/solis-produccion.js
const crypto = require('crypto');
const https  = require('https');

const SOLIS_HOST   = 'www.soliscloud.com';
const SOLIS_PORT   = 13333;
const API_ID       = process.env.SOLIS_API_ID;
const API_SECRET   = process.env.SOLIS_API_SECRET;

// Formato GMT exacto que acepta Solis: "EEE, d MMM yyyy HH:mm:ss GMT" (sin cero en el día)
function getGMTDate() {
  const d = new Date();
  const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const p = n => String(n).padStart(2,'0');
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT`;
}

function getContentMD5(body) {
  return crypto.createHash('md5').update(body).digest('base64');
}

function getSign(contentMD5, contentType, date, path) {
  const str = `POST\n${contentMD5}\n${contentType}\n${date}\n${path}`;
  return crypto.createHmac('sha1', API_SECRET).update(str).digest('base64');
}

// Llamada HTTPS nativa (evita problemas de fetch con puerto no estándar)
function solisRequest(path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr     = JSON.stringify(body);
    const contentType = 'application/json;charset=UTF-8';
    const date        = getGMTDate();
    const contentMD5  = getContentMD5(bodyStr);
    const sign        = getSign(contentMD5, contentType, date, path);

    const options = {
      hostname: SOLIS_HOST,
      port:     SOLIS_PORT,
      path,
      method:   'POST',
      headers: {
        'Content-Type':   contentType,
        'Content-MD5':    contentMD5,
        'Date':           date,
        'Authorization':  `API ${API_ID}:${sign}`,
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.success) return reject(new Error(`Solis: ${json.msg || data}`));
          resolve(json.data);
        } catch(e) {
          reject(new Error(`Parse error: ${data.slice(0,200)}`));
        }
      });
    });
    req.on('error', e => reject(new Error(`Network: ${e.message}`)));
    req.write(bodyStr);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!API_ID || !API_SECRET) {
    return res.status(500).json({ ok: false, error: 'Variables SOLIS_API_ID / SOLIS_API_SECRET no configuradas' });
  }

  try {
    const { tipo = 'lista', fecha } = req.query;

    if (tipo === 'lista') {
      const data = await solisRequest('/v1/api/inverterList', { pageNo: '1', pageSize: '10' });
      const inversores = (data.page?.records || []).map(inv => ({
        id: inv.id, sn: inv.sn,
        potenciaInstalada: inv.power,
        estado: inv.state,
        energiaHoy: inv.eToday,
        energiaTotal: inv.eTotal
      }));
      return res.status(200).json({ ok: true, inversores });
    }

    // Obtener inversor para hoy/mes
    const listaData = await solisRequest('/v1/api/inverterList', { pageNo: '1', pageSize: '10' });
    const inv = (listaData.page?.records || [])[0];
    if (!inv) return res.status(200).json({ ok: false, error: 'No se encontraron inversores' });

    if (tipo === 'hoy') {
      const hoy = fecha || new Date().toISOString().slice(0,10);
      const data = await solisRequest('/v1/api/inverterDay', {
        id: inv.id, sn: inv.sn, money: 'EUR', time: hoy, timeZone: '2'
      });
      return res.status(200).json({
        ok: true, tipo: 'hoy', fecha: hoy, sn: inv.sn,
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
      const mes = fecha || new Date().toISOString().slice(0,7);
      const data = await solisRequest('/v1/api/inverterMonth', {
        id: inv.id, sn: inv.sn, money: 'EUR', month: mes
      });
      return res.status(200).json({
        ok: true, tipo: 'mes', mes, sn: inv.sn,
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
