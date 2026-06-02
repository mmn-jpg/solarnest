// api/test-solis.js — diagnóstico resumido de producción/batería/red
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
      resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e){ resolve({raw:data.slice(0,200)}); } });
    });
    r.on('error', e => resolve({ error: e.message }));
    r.write(body); r.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const lista = await callSolis('/v1/api/inverterList', { pageNo: 1, pageSize: 10 });
  const inv = lista?.data?.page?.records?.[0];
  if (!inv) return res.status(200).json({ error: 'sin inversor', lista });

  const out = {};

  // Día 30 mayo — extraer solo campos clave del punto de MÁXIMA producción
  const day = await callSolis('/v1/api/inverterDay', { id: inv.id, sn: inv.sn, money: 'EUR', time: '2026-05-30', timeZone: 1 });
  const puntos = day?.data || [];
  // Buscar el punto con mayor pac (producción solar máxima del día)
  let maxPac = null;
  for (const p of puntos) {
    if (maxPac === null || (parseFloat(p.pac)||0) > (parseFloat(maxPac.pac)||0)) maxPac = p;
  }
  out.totalPuntosDelDia = puntos.length;
  out.puntoMaxProduccion = maxPac ? {
    hora: maxPac.timeStr,
    pac_solar_kw: maxPac.pac,
    eToday_kwh: maxPac.eToday,
    bateriaSoc: maxPac.batteryCapacitySoc,
    bateriaPower: maxPac.batteryPower,
    consumoCasaHoy: maxPac.homeLoadTodayEnergy,
    vertidoHoy: maxPac.gridSellTodayEnergy,
    compraRedHoy: maxPac.gridPurchasedTodayEnergy,
    cargaBateriaHoy: maxPac.batteryTodayChargeEnergy,
    descargaBateriaHoy: maxPac.batteryTodayDischargeEnergy
  } : null;

  // inverterMonth mayo — estructura
  const month = await callSolis('/v1/api/inverterMonth', { id: inv.id, sn: inv.sn, money: 'EUR', month: '2026-05' });
  out.month_success = month?.success;
  out.month_dataLength = Array.isArray(month?.data) ? month.data.length : 'no es array';
  out.month_primerDia = Array.isArray(month?.data) && month.data[0] ? month.data[0] : month?.data;

  return res.status(200).json(out);
};
