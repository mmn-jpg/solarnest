// api/test-solis.js — diagnóstico de inverterDay e inverterMonth con datos reales
const crypto = require('crypto');
const https  = require('https');

const API_ID     = process.env.SOLIS_API_ID;
const API_SECRET = process.env.SOLIS_API_SECRET;

function callSolis(path, bodyObj) {
  return new Promise((resolve) => {
    const body = JSON.stringify(bodyObj);
    const date = new Date().toUTCString();
    const contentMD5 = crypto.createHash('md5').update(body).digest('base64');
    const sts = `POST\n${contentMD5}\napplication/json\n${date}\n${path}`;
    const sign = crypto.createHmac('sha1', API_SECRET).update(sts).digest('base64');
    const options = {
      hostname: 'www.soliscloud.com', port: 13333, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-MD5': contentMD5, 'Date': date,
        'Authorization': `API ${API_ID}:${sign}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const r = https.request(options, resp => {
      let data = ''; resp.on('data', c => data += c);
      resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e){ resolve({raw:data.slice(0,300)}); } });
    });
    r.on('error', e => resolve({ error: e.message }));
    r.write(body); r.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Primero la lista para obtener id/sn
  const lista = await callSolis('/v1/api/inverterList', { pageNo: 1, pageSize: 10 });
  const inv = lista?.data?.page?.records?.[0];
  if (!inv) return res.status(200).json({ error: 'sin inversor', lista });

  const out = { inversor: { id: inv.id, sn: inv.sn } };

  // inverterDay de un día soleado pasado (ej: 30 mayo) con varios timeZone
  out.day_tz1_30may = await callSolis('/v1/api/inverterDay', { id: inv.id, sn: inv.sn, money: 'EUR', time: '2026-05-30', timeZone: 1 });
  out.day_tz2_30may = await callSolis('/v1/api/inverterDay', { id: inv.id, sn: inv.sn, money: 'EUR', time: '2026-05-30', timeZone: 2 });

  // inverterMonth de mayo (mes completo con producción)
  out.month_mayo = await callSolis('/v1/api/inverterMonth', { id: inv.id, sn: inv.sn, money: 'EUR', month: '2026-05' });

  // inverterDetail para ver el estado actual completo
  out.detail = await callSolis('/v1/api/inverterDetail', { id: inv.id, sn: inv.sn });

  return res.status(200).json(out);
};
