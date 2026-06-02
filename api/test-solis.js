// api/test-solis.js — diagnóstico de la firma Solis
const crypto = require('crypto');
const https  = require('https');

const API_ID     = process.env.SOLIS_API_ID;
const API_SECRET = process.env.SOLIS_API_SECRET;

function getGMTDate() { return new Date().toUTCString(); }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const diag = {};
  diag.tieneID = !!API_ID;
  diag.tieneSecret = !!API_SECRET;
  diag.idLongitud = API_ID ? API_ID.length : 0;
  diag.secretLongitud = API_SECRET ? API_SECRET.length : 0;
  diag.idPrimeros4 = API_ID ? API_ID.slice(0,4) : '';
  diag.secretPrimeros4 = API_SECRET ? API_SECRET.slice(0,4) : '';

  const path = '/v1/api/inverterList';
  const body = JSON.stringify({ pageNo: 1, pageSize: 10 });
  const contentType = 'application/json;charset=UTF-8';
  const date = getGMTDate();
  const contentMD5 = crypto.createHash('md5').update(body).digest('base64');
  const stringToSign = `POST\n${contentMD5}\n${contentType}\n${date}\n${path}`;
  const sign = crypto.createHmac('sha1', API_SECRET || '').update(stringToSign).digest('base64');

  diag.body = body;
  diag.contentMD5 = contentMD5;
  diag.date = date;
  diag.stringToSign = stringToSign;
  diag.sign = sign;
  diag.authorization = `API ${API_ID}:${sign}`;

  // Intentar la llamada real y capturar respuesta cruda
  try {
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'www.soliscloud.com', port: 13333, path, method: 'POST',
        headers: {
          'Content-Type': contentType,
          'Content-MD5': contentMD5,
          'Date': date,
          'Authorization': `API ${API_ID}:${sign}`,
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const r = https.request(options, resp => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => resolve({ status: resp.statusCode, body: data }));
      });
      r.on('error', e => reject(e));
      r.write(body); r.end();
    });
    diag.respuestaSolis = result;
  } catch(e) {
    diag.errorLlamada = e.message;
  }

  return res.status(200).json(diag);
};
