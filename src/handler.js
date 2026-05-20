import KANBAN_HTML from "./kanban.html";
import { renderReport, generateAndSaveNarrative } from "./report.js";

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
  // Cron: viernes 14:00 UTC = 8am Mty (Mexico no aplica DST desde 2022, UTC-6 fijo).
  // En ese momento la semana que acaba de cerrar es la que empezo el viernes anterior:
  // resto 24h al timestamp para caer en jueves y friWeekKey devuelve la llave correcta.
  async scheduled(_event, env, ctx) {
    const targetKey = friWeekKey(Date.now() - 24 * 60 * 60 * 1000);
    ctx.waitUntil(
      generateAndSaveNarrative(env, targetKey).catch(err => {
        console.error("scheduled narrative failed:", err?.message || err);
      })
    );
  },

  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(KANBAN_HTML, {headers:{"Content-Type":"text/html;charset=UTF-8"}});
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
