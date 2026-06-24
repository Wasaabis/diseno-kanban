import KANBAN_HTML from "./kanban.html";
import {
  renderReport, generateAndSaveNarrative,
  generateVerdictReport, formatVerdictForTelegram, sendTelegram,
} from "./report.js";

// I13: candado del kanban. Antes /api/admin/* (datos de staff), /token (mint de access_token de
// Zoho), /fu/mensajes (filtraba el STAFF_BRIDGE_SECRET en la URL del redirect) y /kv estaban
// ABIERTOS a cualquiera con el link. Ahora exigen una cookie de PIN. Fail-closed: sin KANBAN_PIN
// seteado, nadie entra.
function kanbanAuthed(request, env) {
  if (!env.KANBAN_PIN) return false;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)kb_auth=([^;]+)/);
  return !!m && m[1] === env.KANBAN_PIN;
}
const PIN_GATE_HTML = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kanban — acceso</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f4f1}
.box{background:#fff;padding:28px;border-radius:12px;border:1px solid rgba(0,0,0,.1);width:300px;max-width:90vw}
h2{font-size:16px;margin:0 0 16px}input{width:100%;padding:10px;border:1px solid rgba(0,0,0,.15);border-radius:8px;font-size:14px;margin-bottom:12px;box-sizing:border-box}
button{width:100%;padding:10px;border:none;border-radius:8px;background:#2c2c2a;color:#fff;font-size:14px;cursor:pointer}.err{color:#b00;font-size:12px;min-height:16px}</style></head><body>
<div class="box"><h2>Tablero de diseños</h2><input id="pin" type="password" placeholder="PIN de acceso" autofocus>
<div class="err" id="err"></div><button onclick="go()">Entrar</button></div>
<script>async function go(){const pin=document.getElementById('pin').value.trim();const r=await fetch('/acceso',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});if(r.ok){location.reload();}else{document.getElementById('err').textContent='PIN incorrecto';}}
document.getElementById('pin').addEventListener('keydown',e=>{if(e.key==='Enter')go();});</script></body></html>`;

async function runScheduledTasks(env) {
  const now = Date.now();
  // Veredicto + notificacion Telegram
  try {
    const report = await generateVerdictReport(env, now);
    const text = formatVerdictForTelegram(report);
    await sendTelegram(env, text);
  } catch (err) {
    console.error("scheduled verdict failed:", err?.message || err);
  }
  // Narrativa semanal (sin bloquear si falla)
  try {
    const targetKey = friWeekKey(now - 24 * 60 * 60 * 1000);
    await generateAndSaveNarrative(env, targetKey);
  } catch (err) {
    console.error("scheduled narrative failed:", err?.message || err);
  }
}

function friWeekKey(ts) {
  const mx = new Date(ts - 6 * 60 * 60 * 1000);
  const daysSinceFri = (mx.getUTCDay() - 5 + 7) % 7;
  const friday = new Date(mx.getTime() - daysSinceFri * 24 * 60 * 60 * 1000);
  const y = friday.getUTCFullYear();
  const m = String(friday.getUTCMonth() + 1).padStart(2, "0");
  const d = String(friday.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export default {
  // Cron: viernes 21:00 UTC = 15:00 Mty (Mexico UTC-6 fijo).
  // Genera y envia via Telegram el veredicto sabado libre/oficina + flujo semanal.
  // Tambien guarda la narrativa Haiku para la semana viernes-jueves que cerro (mismo timestamp
  // restando 24h cae en jueves y friWeekKey devuelve la llave correcta).
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduledTasks(env));
  },

  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };
    const url = new URL(request.url);
    const authed = kanbanAuthed(request, env);

    // I13: puerta por PIN — setea la cookie kb_auth (HttpOnly).
    if (url.pathname === "/acceso" && request.method === "POST") {
      let pin = "";
      try { pin = (await request.json()).pin || ""; } catch { /* */ }
      if (env.KANBAN_PIN && pin === env.KANBAN_PIN) {
        return new Response(JSON.stringify({ok:true}), {status:200, headers:{"Content-Type":"application/json","Set-Cookie":`kb_auth=${env.KANBAN_PIN}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`}});
      }
      return new Response(JSON.stringify({ok:false,error:"PIN incorrecto"}), {status:401, headers:{"Content-Type":"application/json"}});
    }

    if (url.pathname === "/" || url.pathname === "") {
      if (!authed) return new Response(PIN_GATE_HTML, {status:401, headers:{"Content-Type":"text/html;charset=UTF-8"}});
      return new Response(KANBAN_HTML, {headers:{"Content-Type":"text/html;charset=UTF-8"}});
    }

    // I13: endpoints sensibles (datos de staff, secretos, KV) exigen la cookie de PIN.
    const sensible = url.pathname.startsWith("/api/admin/") || url.pathname === "/fu/mensajes"
      || url.pathname === "/token" || url.pathname === "/kv"
      || url.pathname === "/report" || url.pathname === "/report/verdict";
    if (sensible && !authed) {
      return new Response(JSON.stringify({error:"unauthorized"}), {status:401, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
    }

    // Proxy server-side al worker de la tienda para el chat de pedidos (cards-summary /
    // token-for-card). El secreto x-fu-staff se inyecta AQUÍ y NUNCA viaja al navegador:
    // el kanban llama estos paths en su mismo origen y este worker reenvía con el secreto.
    const TIENDA = "https://foreverus.mx";
    if (url.pathname.startsWith("/api/admin/")) {
      const h = new Headers(request.headers);
      h.set("x-fu-staff", env.STAFF_BRIDGE_SECRET || "");
      const body = (request.method === "GET" || request.method === "HEAD") ? undefined : await request.arrayBuffer();
      // L14: cable directo (service binding) a la tienda — antes fetch a foreverus.mx rebotaba
      // con 404 Worker→Worker en la misma cuenta y el chat de pedidos perdía datos intermitente.
      const resp = await env.TIENDA.fetch(TIENDA + url.pathname + url.search, { method: request.method, headers: h, body });
      const out = new Response(resp.body, { status: resp.status });
      out.headers.set("Content-Type", resp.headers.get("Content-Type") || "application/json");
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    }
    // Link "Mensajes": redirige a la tienda agregando el secreto en ?k (server-side).
    if (url.pathname === "/fu/mensajes") {
      return Response.redirect(TIENDA + "/mensajes?k=" + encodeURIComponent(env.STAFF_BRIDGE_SECRET || ""), 302);
    }

    // /token: refresca access_token usando el refresh_token guardado como secret.
    // El frontend no envia ningun parametro sensible — solo pide y recibe access_token.
    // Bootstrap del refresh_token se hace fuera del Worker (curl manual, ver README).
    if (url.pathname === "/token") {
      if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET || !env.ZOHO_REFRESH_TOKEN) {
        return new Response(JSON.stringify({error:"missing_secrets"}), {status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
      }
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: env.ZOHO_CLIENT_ID,
        client_secret: env.ZOHO_CLIENT_SECRET,
        refresh_token: env.ZOHO_REFRESH_TOKEN
      });
      const resp = await fetch("https://accounts.zoho.com/oauth/v2/token", {method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body});
      const data = await resp.json();
      return new Response(JSON.stringify(data), {headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
    }

    if (url.pathname === "/kv" && request.method === "GET") {
      const key = url.searchParams.get("key");
      const value = await env.KV.get(key);
      return new Response(JSON.stringify({value}), {headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
    }

    if (url.pathname === "/kv" && request.method === "POST") {
      const body = await request.json();
      await env.KV.put(body.key, body.value);
      return new Response(JSON.stringify({ok:true}), {headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
    }

    if (url.pathname === "/report") {
      const week = url.searchParams.get("week") || "";
      const html = await renderReport(env, week);
      return new Response(html, {headers:{"Content-Type":"text/html;charset=UTF-8"}});
    }

    // Backfill / regen manual. Mario lo dispara desde terminal:
    //   curl -X POST "https://<worker>/report/generate?week=20260508&force=1"
    // Sin week: usa la semana que acaba de cerrar (Vie pasado).
    if (url.pathname === "/report/generate" && request.method === "POST") {
      const force = url.searchParams.get("force") === "1";
      const week = url.searchParams.get("week") || friWeekKey(Date.now() - 24*60*60*1000);
      if (!force) {
        const existing = await env.KV.get("report:" + week);
        if (existing) {
          return new Response(JSON.stringify({ok:true, week, skipped:"already_exists", narrative:existing}), {headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
        }
      }
      try {
        const result = await generateAndSaveNarrative(env, week);
        return new Response(JSON.stringify({ok:true, ...result}), {headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
      } catch (err) {
        return new Response(JSON.stringify({ok:false, week, error:String(err?.message || err)}), {status:500, headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
      }
    }

    // Veredicto del corte que se ejecutaria AHORA (preview en JSON).
    // Para HTML/banner visual, el dato vive en este JSON — el front del kanban podria consumirlo.
    if (url.pathname === "/report/verdict" && request.method === "GET") {
      try {
        const report = await generateVerdictReport(env, Date.now());
        return new Response(JSON.stringify({
          ok: true,
          cutoff: report.cutoff,
          start: report.start,
          veredicto: report.verdict.veredicto,
          f3Total: report.verdict.f3Count,
          rojas: report.verdict.rojas.map(c => ({
            nota: c.nota, joyeria: c.joyeria, col: c.col, status: c.status,
            dVida: c.dVida, dStatus: c.dStatus,
            motivo: c.cVida === "rojo" && c.cStatus === "rojo" ? "vida+status" : c.cVida === "rojo" ? "vida total" : "status",
          })),
          weekendEvents: report.weekendEvents.length,
          flow: report.flow,
          stuck: { f3Count: report.stuck.f3.length, otrasCount: report.stuck.otras.length },
        }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      }
    }

    // Disparo del flujo veredicto + Telegram. Lo invoca GitHub Actions los viernes 21:00 UTC
    // (.github/workflows/viernes-3pm.yml). Tambien sirve para test manual:
    //   curl -X POST -H "X-Notify-Token: <token>" "https://<worker>/report/notify"
    // Requiere header X-Notify-Token = secret NOTIFY_TOKEN del worker, para que nadie spammee.
    if (url.pathname === "/report/notify" && request.method === "POST") {
      if (!env.NOTIFY_TOKEN || request.headers.get("X-Notify-Token") !== env.NOTIFY_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: "forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
      try {
        const report = await generateVerdictReport(env, Date.now());
        const text = formatVerdictForTelegram(report);
        await sendTelegram(env, text);
        return new Response(JSON.stringify({ ok: true, sent: true, length: text.length }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
      }
    }

    if (url.pathname === "/events" && request.method === "POST") {
      const payload = await request.json();
      const events = Array.isArray(payload) ? payload : [payload];
      const buckets = {};
      for (const ev of events) {
        const at = ev.at || Date.now();
        const key = "events:" + friWeekKey(at);
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push({...ev, at});
      }
      for (const key of Object.keys(buckets)) {
        const existing = await env.KV.get(key);
        const list = existing ? JSON.parse(existing) : [];
        list.push(...buckets[key]);
        await env.KV.put(key, JSON.stringify(list));
      }
      return new Response(JSON.stringify({ok:true, count:events.length}), {headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
    }

    if (url.pathname === "/events" && request.method === "GET") {
      const week = url.searchParams.get("week") || friWeekKey(Date.now());
      const data = await env.KV.get("events:" + week);
      return new Response(data || "[]", {headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
    }

    if (url.pathname === "/zoho") {
      if (request.method === "OPTIONS") return new Response(null, {headers:cors});
      const zohoUrl = url.searchParams.get("url");
      if (!zohoUrl) return new Response("Falta url", {status:400, headers:cors});
      const auth = request.headers.get("authorization") || request.headers.get("Authorization");
      const ct = request.headers.get("content-type");
      const fwdHeaders = {};
      if (auth) fwdHeaders.Authorization = auth;
      if (ct) fwdHeaders["Content-Type"] = ct;
      const init = {method:request.method, headers:fwdHeaders};
      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = await request.text();
      }
      const resp = await fetch(zohoUrl, init);
      const text = await resp.text();
      return new Response(text, {status:resp.status, headers:{...cors,"Content-Type":"application/json"}});
    }

    return new Response("Forever Us Worker activo", {headers:cors});
  },
};
