import KANBAN_HTML from "./kanban.html";
import { renderReport } from "./report.js";

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

    if (url.pathname === "/token") {
      const grant_type = url.searchParams.get("grant_type") || "authorization_code";
      let body;
      if (grant_type === "refresh") {
        const rt = url.searchParams.get("refresh_token");
        body = new URLSearchParams({grant_type:"refresh_token", client_id:"1000.RERIFMR5TE3GIC5F2K7FNXZ6F3NP2M", client_secret:"2584fefcf66e1bc7c5762a30adc1e213a0921f64a2", refresh_token:rt});
      } else {
        body = new URLSearchParams({grant_type:"authorization_code", client_id:url.searchParams.get("client_id"), client_secret:url.searchParams.get("client_secret"), redirect_uri:url.searchParams.get("redirect_uri"), code:url.searchParams.get("code")});
      }
      const resp = await fetch("https://accounts.zoho.com/oauth/v2/token", {method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body});
      const data = await resp.json();
      if (grant_type === "refresh") {
        return new Response(JSON.stringify(data), {headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}});
      }
      const html = "<!DOCTYPE html><html><head><title>Token</title><style>body{font-family:sans-serif;max-width:560px;margin:60px auto;padding:20px;background:#f5f5f5}.box{background:#fff;padding:16px;border-radius:8px;margin:12px 0;border:1px solid #ddd}code{display:block;background:#f0f0f0;padding:10px;border-radius:4px;word-break:break-all;font-size:11px}.ok{color:#0a0}.err{color:#c00}button{background:#0066cc;color:#fff;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;margin-left:8px}</style></head><body><h2>Zoho OAuth</h2>" +
        (data.error
          ? "<div class=\"box\"><p class=\"err\">Error: " + data.error + "</p><p>" + (data.error_description||"") + "</p></div>"
          : "<div class=\"box\"><p class=\"ok\">Conexion exitosa</p><p style=\"font-size:11px;color:#888;margin:8px 0 4px\">ACCESS TOKEN</p><code id=\"at\">" + data.access_token + "</code><button onclick=\"navigator.clipboard.writeText(document.getElementById('at').textContent);this.textContent='Copiado!'\">Copiar</button></div><div class=\"box\"><p style=\"font-size:11px;color:#888;margin:0 0 4px\">REFRESH TOKEN</p><code>" + data.refresh_token + "</code></div>"
        ) + "</body></html>";
      return new Response(html, {headers:{"Content-Type":"text/html;charset=UTF-8"}});
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
      const zohoUrl = url.searchParams.get("url");
      if (!zohoUrl) return new Response("Falta url", {status:400, headers:cors});
      const auth = request.headers.get("authorization") || request.headers.get("Authorization");
      const resp = await fetch(zohoUrl, {method:request.method, headers:auth?{Authorization:auth}:{}});
      const text = await resp.text();
      return new Response(text, {status:resp.status, headers:{...cors,"Content-Type":"application/json"}});
    }

    return new Response("Forever Us Worker activo", {headers:cors});
  },
};
