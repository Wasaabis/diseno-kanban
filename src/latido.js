// ============================================================
// latido.js — dejar constancia en la bitácora del hub
// ============================================================
// Este worker corría a ciegas: cuando su cron fallaba, el error se iba a
// `console.error`, donde no lo lee nadie salvo que alguien tenga `wrangler tail`
// abierto en ese momento exacto. Un proceso que se cae en silencio es
// indistinguible de uno que funciona — así estuvo 31 días el espejo del banco.
//
// Ahora cada corrida deja su renglón en `cron_runs` de la base del hub, y de ahí
// lo levanta Signos Vitales: se registra solo y avisa al grupo de Sistema si deja
// de latir. La bitácora vive en el hub y no aquí, a propósito: la vigilancia no
// puede depender del sistema vigilado.
//
// El nombre lleva prefijo de worker para no chocar con los crons del ERP, que
// viven en la misma tabla.
// ============================================================

export async function latido(db, nombre, fn) {
  const id = crypto.randomUUID();
  const inicio = Date.now();

  try {
    await db.prepare(`INSERT INTO cron_runs (id, cron_name, status) VALUES (?, ?, 'running')`)
      .bind(id, nombre).run();
  } catch {
    // Anotar nunca puede impedir trabajar.
    return fn().then(() => {}, (e) => console.error(`[${nombre}] (sin bitacora)`, e));
  }

  try {
    const resumen = await fn();
    await db.prepare(
      `UPDATE cron_runs SET status='ok', finished_at=datetime('now'), duration_ms=?, summary=? WHERE id=?`
    ).bind(Date.now() - inicio, resumen || null, id).run();
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err);
    await db.prepare(
      `UPDATE cron_runs SET status='error', finished_at=datetime('now'), duration_ms=?, error=? WHERE id=?`
    ).bind(Date.now() - inicio, msg.slice(0, 4000), id).run();
    console.error(`[${nombre}] ERROR:`, msg);
  }
}
