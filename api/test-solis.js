// api/test-solis.js — diagnóstico: prueba variantes de firma contra Solis
const crypto = require('crypto');
const https  = require('https');

const API_ID     = process.env.SOLIS_API_ID;
const API_SECRET = process.env.SOLIS_API_SECRET;

function callSolis(path, body, contentTypeHeader, contentTypeSign) {
  return new Promise((resolve) => {
    const date = new Date().toUTCString();
    const contentMD5 = crypto.createHash('md5').update(body).digest('base64');
    const sts = `POST\n${contentMD5}\n${contentTypeSign}\n${date}\n${path}`;
    const sign = crypto.createHmac('sha1', API_SECRET).update(sts).digest('base64');
    const options = {
      hostname: 'www.soliscloud.com', port: 13333, path, method: 'POST',
      headers: {
        'Content-Type': contentTypeHeader,
        'Content-MD5': contentMD5,
        'Date': date,
        'Authorization': `API ${API_ID}:${sign}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const r = https.request(options, resp => {
      let data = ''; resp.on('data', c => data += c);
      resp.on('end', () => resolve({ status: resp.statusCode, body: data.slice(0,200) }));
    });
    r.on('error', e => resolve({ error: e.message }));
    r.write(body); r.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const path = '/v1/api/inverterList';
  const body = JSON.stringify({ pageNo: 1, pageSize: 10 });

  const pruebas = {};
  // Variante A: charset en header Y en firma
  pruebas.A_charset_en_ambos = await callSolis(path, body, 'application/json;charset=UTF-8', 'application/json;charset=UTF-8');
  // Variante B: charset en header pero NO en firma
  pruebas.B_charset_solo_header = await callSolis(path, body, 'application/json;charset=UTF-8', 'application/json');
  // Variante C: sin charset en ninguno
  pruebas.C_sin_charset = await callSolis(path, body, 'application/json', 'application/json');

  return res.status(200).json(pruebas);
};
