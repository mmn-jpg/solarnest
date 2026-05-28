// =============================================================
//  SolarNest · Función de PRUEBA de Datadis
//  Vive en Vercel. Comprueba que tu cuenta de Datadis funciona:
//   1) Pide un token con tu NIF + contraseña
//   2) Con ese token, lista tus suministros (CUPS)
//  Tus credenciales NO están aquí: se leen de variables de
//  entorno cifradas en Vercel (DATADIS_USER y DATADIS_PASS).
// =============================================================

export default async function handler(req, res) {
  // Cabeceras para poder llamarla desde el navegador / la app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const USER = process.env.DATADIS_USER; // tu NIF (lo pones en Vercel)
  const PASS = process.env.DATADIS_PASS; // tu contraseña de Datadis

  // Comprobación 0: ¿están configuradas las credenciales?
  if (!USER || !PASS) {
    return res.status(500).json({
      ok: false,
      paso: 'configuracion',
      error: 'Faltan las variables DATADIS_USER y/o DATADIS_PASS en Vercel.'
    });
  }

  try {
    // ---- PASO 1: pedir el token (POST con form-urlencoded) ----
    const auth = await fetch('https://datadis.es/nikola-auth/tokens/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: USER, password: PASS }).toString()
    });

    if (!auth.ok) {
      const texto = await auth.text();
      return res.status(200).json({
        ok: false,
        paso: 'login',
        httpStatus: auth.status,
        pista: auth.status === 401 || auth.status === 403
          ? 'NIF o contraseña incorrectos, o la cuenta aún no tiene acceso API.'
          : 'Datadis respondió con un error en el login.',
        respuesta: texto.slice(0, 300)
      });
    }

    // El token llega como texto plano (un JWT largo)
    const token = (await auth.text()).trim();

    // ---- PASO 2: con el token, pedir los suministros ----
    const sup = await fetch('https://datadis.es/api-private/api/get-supplies', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
    });

    if (!sup.ok) {
      const texto = await sup.text();
      return res.status(200).json({
        ok: false,
        paso: 'get-supplies',
        httpStatus: sup.status,
        pista: 'El token se obtuvo bien, pero la consulta de suministros falló. '
             + 'Esto es lo que algunos usuarios particulares reportan (errores 500/504).',
        respuesta: texto.slice(0, 300)
      });
    }

    const suministros = await sup.json();

    // ---- ÉXITO: devolvemos un resumen legible ----
    return res.status(200).json({
      ok: true,
      paso: 'completado',
      mensaje: '¡Funciona! Datadis ha devuelto tus suministros.',
      numeroSuministros: Array.isArray(suministros) ? suministros.length : 0,
      suministros: (Array.isArray(suministros) ? suministros : []).map(s => ({
        cups: s.cups,
        direccion: s.address,
        municipio: s.municipality,
        distribuidora: s.distributor,
        distributorCode: s.distributorCode,
        validoDesde: s.validDateFrom,
        validoHasta: s.validDateTo
      }))
    });

  } catch (e) {
    return res.status(200).json({
      ok: false,
      paso: 'excepcion',
      error: String(e),
      pista: 'Error inesperado al contactar con Datadis.'
    });
  }
}
