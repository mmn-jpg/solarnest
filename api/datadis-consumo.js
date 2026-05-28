// =============================================================
//  SolarNest · Consumo real desde Datadis
//  Pide tu consumo horario a Datadis y lo resume por días.
//
//  Uso:
//   /api/datadis-consumo                 -> mes actual
//   /api/datadis-consumo?mes=2026/04     -> un mes concreto (AAAA/MM)
//
//  Credenciales: variables de entorno DATADIS_USER y DATADIS_PASS
// =============================================================

const CUPS = 'ES0031408041899001FT0F'; // tu suministro
const DISTRIBUTOR = '2';               // E-distribución
const POINT_TYPE = '5';                // tipo de punto (doméstico habitual)

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

  try {
    // 1) token
    const auth = await fetch('https://datadis.es/nikola-auth/tokens/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: USER, password: PASS }).toString()
    });
    if (!auth.ok) {
      return res.status(200).json({ ok: false, paso: 'login', httpStatus: auth.status,
        pista: 'No se pudo iniciar sesión en Datadis.' });
    }
    const token = (await auth.text()).trim();

    // 2) consumo del mes
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
      return res.status(200).json({ ok: true, mesConsultado: mes, registros: 0,
        mensaje: 'Sin datos para ese mes (puede que aún no estén validados).' });
    }

    // 3) resumir por día y total
    const porDia = {};
    let totalMes = 0;
    for (const r of datos) {
      const kwh = Number(r.consumptionKWh) || 0;
      totalMes += kwh;
      const dia = r.date; // formato AAAA/MM/DD
      if (!porDia[dia]) porDia[dia] = 0;
      porDia[dia] += kwh;
    }
    const dias = Object.keys(porDia).sort().map(d => ({ dia: d, kwh: Number(porDia[d].toFixed(3)) }));

    return res.status(200).json({
      ok: true,
      mesConsultado: mes,
      registrosHorarios: datos.length,
      totalMesKWh: Number(totalMes.toFixed(2)),
      numeroDias: dias.length,
      primerRegistro: { fecha: datos[0].date, hora: datos[0].time, kwh: datos[0].consumptionKWh, metodo: datos[0].obtainMethod },
      consumoPorDia: dias
    });

  } catch (e) {
    return res.status(200).json({ ok: false, paso: 'excepcion', error: String(e) });
  }
}
