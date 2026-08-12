const DAY_MS = 24 * 60 * 60 * 1000;
const COL_ORDER = ["diseno", "envio", "confirmado"];
const COL_LABELS = {
  diseno: "Diseño",
  envio: "Envio",
  confirmado: "Confirmado",
};
const COL_ACCENT = {
  diseno: "#2ECC71",
  envio: "#F4A100",
  confirmado: "#8B5CF6",
};
// Terminales (no cuentan como estancadas):
//   IMPRESO/NO NECESITA: cerro el flujo de diseño, esperando boton "Enviar a Vaciado".
//   ESPERA - GEMA: pausada esperando gema/diamante.
//   ESPERA - MTTO: pausada esperando el anillo del cliente para adaptar.
//   ESPERA: legacy (data vieja antes de subdividir).
// Ninguna es culpa del diseñador. El evento "terminated" lo emite solo el boton.
const TERMINAL = { confirmado: ["IMPRESO", "NO NECESITA", "ESPERA - GEMA", "ESPERA - MTTO", "ESPERA"] };

function isTerminal(col, status) {
  return (TERMINAL[col] || []).includes(status);
}

function daysBetween(a, b) {
  return Math.floor((b - a) / DAY_MS);
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

function weekLabel(key) {
  const y = key.slice(0, 4), m = key.slice(4, 6), d = key.slice(6, 8);
  const fri = new Date(`${y}-${m}-${d}T00:00:00-06:00`);
  const thu = new Date(fri.getTime() + 6 * DAY_MS);
  const fmt = (dt) => dt.toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", day: "numeric", month: "short" });
  return `Vie ${fmt(fri)} → Jue ${fmt(thu)} ${y}`;
}

function computeMetrics(events) {
  let born = 0, terminated = 0, moves = 0, forward = 0, backward = 0;
  const termEvents = [];
  const bornMap = {};
  for (const ev of events) {
    if (ev.type === "born") {
      born++;
      bornMap[ev.cardId] = ev.at;
    } else if (ev.type === "terminated") {
      terminated++;
      termEvents.push(ev);
    } else if (ev.type === "col_change") {
      moves++;
      const fi = COL_ORDER.indexOf(ev.from);
      const ti = COL_ORDER.indexOf(ev.to);
      if (fi >= 0 && ti >= 0) {
        if (ti > fi) forward++;
        else if (ti < fi) backward++;
      }
    }
  }
  const leads = [];
  for (const t of termEvents) {
    const b = bornMap[t.cardId];
    if (b) leads.push((t.at - b) / DAY_MS);
  }
  leads.sort((a, b) => a - b);
  const stats = {
    avg: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null,
    median: leads.length ? leads[Math.floor(leads.length / 2)] : null,
    p90: leads.length ? leads[Math.floor(leads.length * 0.9)] : null,
    count: leads.length,
  };
  return { born, terminated, moves, forward, backward, leads: stats, net: born - terminated };
}

function computeStuck(positions) {
  const now = Date.now();
  const stuck = [];
  for (const [id, p] of Object.entries(positions)) {
    if (isTerminal(p.col, p.status)) continue;
    if (!p.bornAt) continue;
    const dT = daysBetween(p.bornAt, now);
    const dC = daysBetween(p.colSince || p.bornAt, now);
    if (dT >= 7 || dC >= 3) {
      stuck.push({
        id,
        col: p.col,
        status: p.status,
        daysTotal: dT,
        daysInCol: dC,
        joyeria: p.joyeria || "?",
        nota: p.nota || "?",
      });
    }
  }
  stuck.sort((a, b) => b.daysTotal - a.daysTotal);
  return stuck;
}

function computeSnapshot(positions) {
  const now = Date.now();
  const cols = {};
  for (const col of COL_ORDER) cols[col] = { count: 0, ageSum: 0 };
  for (const [, p] of Object.entries(positions)) {
    if (!cols[p.col]) cols[p.col] = { count: 0, ageSum: 0 };
    cols[p.col].count++;
    cols[p.col].ageSum += daysBetween(p.bornAt || now, now);
  }
  const result = {};
  for (const [col, v] of Object.entries(cols)) {
    result[col] = { count: v.count, avgAge: v.count ? (v.ageSum / v.count).toFixed(1) : "0.0" };
  }
  return result;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt1(n) {
  return n == null ? "—" : Number(n).toFixed(1);
}

function renderHTML({ week, weeks, metrics, stuck, snapshot, narrative }) {
  const netBadge = metrics.net > 0
    ? `<span style="color:#C05C00">+${metrics.net}</span>`
    : metrics.net < 0 ? `<span style="color:#1E7E34">${metrics.net}</span>` : `<span>0</span>`;

  const weekOptions = weeks.map(w => `<option value="${w}" ${w === week ? "selected" : ""}>${weekLabel(w)}</option>`).join("");

  const stuckRows = stuck.length === 0
    ? `<tr><td colspan="5" style="text-align:center;color:#666;padding:20px">Nada estancado 🎉</td></tr>`
    : stuck.map(s => `
      <tr class="${s.daysTotal >= 14 ? "critical" : s.daysTotal >= 10 ? "bad" : ""}">
        <td><strong>${esc(s.nota)}</strong><div class="muted">${esc(s.joyeria)}</div></td>
        <td><span class="pill" style="background:${COL_ACCENT[s.col]}22;color:${COL_ACCENT[s.col]}">${esc(COL_LABELS[s.col] || s.col)}</span><div class="muted">${esc(s.status)}</div></td>
        <td class="num">${s.daysTotal}d</td>
        <td class="num">${s.daysInCol}d</td>
        <td>${s.daysTotal >= 14 ? "🚨 crítica" : s.daysTotal >= 10 ? "⚠ vieja" : s.daysInCol >= 3 ? "⏸ sin movimiento" : ""}</td>
      </tr>
    `).join("");

  const snapshotRows = COL_ORDER.map(col => {
    const s = snapshot[col] || { count: 0, avgAge: "0.0" };
    return `<tr><td><span class="pill" style="background:${COL_ACCENT[col]}22;color:${COL_ACCENT[col]}">${COL_LABELS[col]}</span></td><td class="num">${s.count}</td><td class="num">${s.avgAge}d</td></tr>`;
  }).join("");

  const narrativeHTML = narrative
    ? `<div class="narrative">${narrative}</div>`
    : `<div class="narrative placeholder">El reporte narrativo se genera automáticamente cada viernes 8am. Si aún no aparece, esta semana no se ha procesado.</div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Reporte · Forever Us</title>
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:"Open Sans",sans-serif;background:#F4F5F7;color:#1A1A2E;padding:24px;max-width:1100px;margin:0 auto;}
h1{font-size:22px;font-weight:700;margin-bottom:4px;}
h2{font-size:14px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:0.6px;margin:28px 0 12px;}
.head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:20px;}
.back{font-size:12px;color:#3A86FF;text-decoration:none;}
select{font-family:inherit;font-size:13px;padding:6px 10px;border:1px solid #DDD;border-radius:6px;background:#FFF;}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;}
.kpi{background:#FFF;border:1px solid #E8E8F0;border-radius:10px;padding:14px 16px;}
.kpi .label{font-size:10px;text-transform:uppercase;color:#888;letter-spacing:0.6px;font-weight:600;}
.kpi .val{font-size:24px;font-weight:700;margin-top:4px;font-family:"JetBrains Mono",monospace;}
.kpi .sub{font-size:11px;color:#666;margin-top:2px;}
table{width:100%;background:#FFF;border:1px solid #E8E8F0;border-radius:10px;border-collapse:collapse;overflow:hidden;}
th{background:#FAFAFB;text-align:left;padding:10px 14px;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid #E8E8F0;}
td{padding:12px 14px;font-size:13px;border-bottom:1px solid #F3F3F6;vertical-align:top;}
tr:last-child td{border-bottom:none;}
tr.bad{background:#FFF9F0;}
tr.critical{background:#FFF2F2;}
.num{font-family:"JetBrains Mono",monospace;text-align:right;}
.pill{display:inline-block;padding:3px 9px;border-radius:20px;font-size:10px;font-weight:600;font-family:"JetBrains Mono",monospace;}
.muted{font-size:11px;color:#888;margin-top:2px;}
.narrative{background:#FFF;border-left:3px solid #3A86FF;border-radius:6px;padding:16px 20px;font-size:14px;line-height:1.55;white-space:pre-wrap;}
.narrative.placeholder{border-left-color:#CCC;color:#888;font-style:italic;}
.leadcard{display:flex;gap:24px;padding:14px 16px;background:#FFF;border:1px solid #E8E8F0;border-radius:10px;}
.leadcard .item{text-align:center;}
.leadcard .item .label{font-size:10px;text-transform:uppercase;color:#888;letter-spacing:0.6px;}
.leadcard .item .val{font-size:20px;font-weight:700;font-family:"JetBrains Mono",monospace;}
</style>
</head>
<body>
<div class="head">
  <div>
    <a class="back" href="/">← Volver al tablero</a>
    <h1>Reporte de rendimiento</h1>
    <div style="font-size:12px;color:#666;margin-top:2px;">${weekLabel(week)}</div>
  </div>
  <form method="get"><select name="week" onchange="this.form.submit()">${weekOptions}</select></form>
</div>

<h2>📊 Narrativa de la semana</h2>
${narrativeHTML}

<h2>🚧 Estancadas de más (≥7d totales o ≥3d sin movimiento)</h2>
<table>
  <thead><tr><th>Tarjeta</th><th>Columna · Status</th><th class="num">Edad total</th><th class="num">En fase</th><th>Nota</th></tr></thead>
  <tbody>${stuckRows}</tbody>
</table>

<h2>📥 Flujo semanal</h2>
<div class="cards">
  <div class="kpi"><div class="label">Nacieron</div><div class="val">${metrics.born}</div><div class="sub">Nuevas al tablero</div></div>
  <div class="kpi"><div class="label">Terminaron</div><div class="val">${metrics.terminated}</div><div class="sub">IMPRESO o NO NECESITA</div></div>
  <div class="kpi"><div class="label">Neto</div><div class="val">${netBadge}</div><div class="sub">${metrics.net > 0 ? "Backlog crece" : metrics.net < 0 ? "Backlog baja" : "Equilibrado"}</div></div>
  <div class="kpi"><div class="label">Movimientos</div><div class="val">${metrics.moves}</div><div class="sub">${metrics.forward} avances · ${metrics.backward} retrocesos</div></div>
</div>

<h2>⏱ Tiempo de ciclo (de las terminadas nacidas esta semana)</h2>
<div class="leadcard">
  <div class="item"><div class="label">Muestra</div><div class="val">${metrics.leads.count}</div></div>
  <div class="item"><div class="label">Promedio</div><div class="val">${fmt1(metrics.leads.avg)}d</div></div>
  <div class="item"><div class="label">Mediana</div><div class="val">${fmt1(metrics.leads.median)}d</div></div>
  <div class="item"><div class="label">P90</div><div class="val">${fmt1(metrics.leads.p90)}d</div></div>
</div>

<h2>📍 Snapshot actual por columna</h2>
<table>
  <thead><tr><th>Columna</th><th class="num">Tarjetas</th><th class="num">Edad promedio</th></tr></thead>
  <tbody>${snapshotRows}</tbody>
</table>

<div style="margin-top:40px;text-align:center;font-size:11px;color:#AAA;">Forever Us · Kanban · ${new Date().toLocaleDateString("es-MX", {timeZone:"America/Mexico_City"})}</div>
</body>
</html>`;
}

// ── Narrativa automática (cron de los viernes) ────────────────────────────
//
// Llama a la API de Anthropic con un resumen estructurado de la semana y
// guarda el párrafo resultante en KV bajo "report:<weekKey>". Se ejecuta
// desde el scheduled handler los viernes a las 14:00 UTC = 8am Mty.

import Anthropic from "@anthropic-ai/sdk";

const NARRATIVE_SYSTEM_PROMPT = "Eres analista de un kanban de diseño de joyería Forever Us. Escribe un resumen narrativo de la semana en español, 4-6 oraciones, tono directo y claro, dirigido al equipo. Sin emojis ni listas. Destaca: dinámica entrada vs terminadas, tiempo de ciclo, tarjetas estancadas críticas (si las hay), y cierra con un \"siguiente foco\" concreto.";

function buildContextText({ weekLabelStr, metrics, stuck, snapshot }) {
  const stuckTop = stuck.slice(0, 6).map(s =>
    `- "${s.nota}" (${s.joyeria}) — ${s.daysTotal}d totales, ${s.daysInCol}d en ${COL_LABELS[s.col] || s.col}/${s.status}`
  ).join("\n") || "- (nada estancado)";

  const snapLines = COL_ORDER.map(c => {
    const s = snapshot[c] || { count: 0, avgAge: "0.0" };
    return `- ${COL_LABELS[c]}: ${s.count} tarjeta(s), edad promedio ${s.avgAge}d`;
  }).join("\n");

  return `Datos de la semana ${weekLabelStr}:
- Nacieron: ${metrics.born}
- Terminaron: ${metrics.terminated}
- Neto: ${metrics.net} (positivo = backlog crece)
- Movimientos: ${metrics.moves} (${metrics.forward} avances, ${metrics.backward} retrocesos)
- Lead time (de terminadas nacidas esta semana): promedio ${fmt1(metrics.leads.avg)}d, mediana ${fmt1(metrics.leads.median)}d, P90 ${fmt1(metrics.leads.p90)}d, muestra ${metrics.leads.count}

Estancadas (top por edad):
${stuckTop}

Snapshot actual por columna:
${snapLines}`;
}

async function callClaudeHaiku(apiKey, contextText) {
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 500,
    system: NARRATIVE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: contextText }],
  });
  for (const block of response.content) {
    if (block.type === "text") {
      const text = block.text?.trim();
      if (text) return text;
    }
  }
  throw new Error("Respuesta sin texto");
}

export async function generateAndSaveNarrative(env, weekKey) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("Falta secret ANTHROPIC_API_KEY");
  const [events, positionsRaw] = await Promise.all([
    env.KV.get("events:" + weekKey),
    env.KV.get("positions"),
  ]);
  const parsedEvents = events ? JSON.parse(events) : [];
  const positions = positionsRaw ? JSON.parse(positionsRaw) : {};
  const ctx = buildContextText({
    weekLabelStr: weekLabel(weekKey),
    metrics: computeMetrics(parsedEvents),
    stuck: computeStuck(positions),
    snapshot: computeSnapshot(positions),
  });
  const narrative = await callClaudeHaiku(env.ANTHROPIC_API_KEY, ctx);
  await env.KV.put("report:" + weekKey, narrative);
  return { weekKey, narrative };
}

// ════════════════════════════════════════════════════════════════════════════
// VEREDICTO SEMANAL — cron viernes 15:00 MX, notificacion Telegram a Mario
// Reglas: memoria del equipo `project_veredicto_armando_criterios.md`.
//   - Solo F3 cuenta para juzgar. F1/F2 son informativos.
//   - Semaforo: peor(vida, status). Vida >12d rojo. Status >5d rojo.
//   - Excluidos: ESPERA-*, IMPRESO, NO NECESITA, IMPRIMIENDO.
//   - Ventana: vie 15:00 anterior → vie 15:00 actual (7 dias exactos).
//     Si Armando vino sab/dom, esos eventos se cuentan y se destacan aparte.
//   - Analisis de chat para repartir culpa: DEFINIDO, NO IMPLEMENTADO TODAVIA.
// ════════════════════════════════════════════════════════════════════════════

const EXCLUIDOS_VEREDICTO = new Set([
  "ESPERA - GEMA", "ESPERA - MTTO", "ESPERA",
  "IMPRESO", "NO NECESITA", "IMPRIMIENDO",
  // CON CLIENTE: la bola esta en la cancha del cliente (ventas ya le mando los
  // renders y esta esperando respuesta). Que el cliente se tarde no es atraso de
  // Armando, asi que no puede voltear el veredicto del sabado a "oficina".
  "CON CLIENTE",
]);

// Estados que "esconden" una tarjeta del veredicto sin producirla. Si la piedra ya
// llegó en LGD (piedra_status='LLEGÓ'), la espera es FALSA y la tarjeta cuenta como
// roja igual — el escondite no vale. IMPRIMIENDO/IMPRESO son producción real, no aquí.
const HIDE_FALSA = new Set(["ESPERA - GEMA", "ESPERA - MTTO", "ESPERA", "NO NECESITA"]);

// Lee las piedras reales de la base LGD (binding D1 `LGD`). Devuelve mapa nota→registro.
// Falla-suave: si el binding no está o la query truena, regresa {} y el veredicto sigue
// funcionando con solo F3 (nunca tumba el reporte del viernes por esto).
async function fetchPiedrasLGD(env) {
  if (!env.LGD) return {};
  try {
    const { results } = await env.LGD.prepare(
      "SELECT nota_number, piedra_status, cert_number FROM order_items WHERE nota_number IS NOT NULL"
    ).all();
    const map = {};
    for (const r of results) map[r.nota_number] = r;
    return map;
  } catch (e) {
    console.error("fetchPiedrasLGD failed:", e?.message || e);
    return {};
  }
}

// Esperas falsas: tarjeta escondida en ESPERA-*/NO NECESITA cuya piedra YA LLEGÓ en LGD.
function computeFalseWaits(positions, piedraMap) {
  const falsas = [];
  for (const [id, p] of Object.entries(positions)) {
    if (!HIDE_FALSA.has(p.status)) continue;
    const g = piedraMap[p.nota];
    if (g && g.piedra_status === "LLEGÓ") {
      falsas.push({ id, nota: p.nota, joyeria: p.joyeria, col: p.col, status: p.status, cert: g.cert_number });
    }
  }
  return falsas;
}

function colorVida(d) { return d <= 7 ? "verde" : d <= 12 ? "amarillo" : "rojo"; }
function colorStatus(d) { return d <= 3 ? "verde" : d <= 5 ? "amarillo" : "rojo"; }
function peorColor(a, b) {
  const rank = { verde: 0, amarillo: 1, rojo: 2 };
  return rank[a] >= rank[b] ? a : b;
}

// Vie 15:00 MX (UTC-6 fijo) = vie 21:00 UTC. Devuelve el ultimo <= nowMs.
export function previousFriday15MX(nowMs) {
  for (let i = 0; i < 14; i++) {
    const candidate = new Date(nowMs - i * DAY_MS);
    const mx = new Date(candidate.getTime() - 6 * 60 * 60 * 1000);
    if (mx.getUTCDay() === 5) {
      const fri15 = Date.UTC(mx.getUTCFullYear(), mx.getUTCMonth(), mx.getUTCDate(), 21, 0, 0);
      if (fri15 <= nowMs) return fri15;
    }
  }
  throw new Error("no friday cutoff found");
}

function isWeekendMX(ts) {
  const mx = new Date(ts - 6 * 60 * 60 * 1000);
  const dow = mx.getUTCDay();
  return dow === 6 || dow === 0; // sab=6, dom=0
}

async function getZohoAccessToken(env) {
  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET || !env.ZOHO_REFRESH_TOKEN) {
    throw new Error("Faltan secrets ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    refresh_token: env.ZOHO_REFRESH_TOKEN,
  });
  const r = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Zoho no devolvio access_token: " + JSON.stringify(j));
  return j.access_token;
}

async function fetchFasesFromZoho(env) {
  const token = await getZohoAccessToken(env);
  const url = "https://www.zohoapis.com/crm/v2/Quotes/search?criteria=(Etapa:equals:Dise%C3%B1o)&per_page=200";
  const r = await fetch(url, { headers: { Authorization: "Zoho-oauthtoken " + token } });
  const j = await r.json();
  const out = {};
  for (const rec of (j.data || [])) {
    const m = (rec.Fases || "").match(/(\d)/);
    out[rec.id] = m ? `F${m[1]}` : null;
  }
  return out;
}

function faseDe(map, id) { return map[id] || "?"; }
function emptyBucket() { return { F1: 0, F2: 0, F3: 0, "?": 0 }; }
function totalBucket(b) { return b.F1 + b.F2 + b.F3 + b["?"]; }
function fmtBucket(b) {
  const base = `F1: ${b.F1} · F2: ${b.F2} · F3: ${b.F3}`;
  return b["?"] ? `${base} · ?: ${b["?"]}` : base;
}

function computeFlowWindow(eventsInWindow, fasePorId) {
  const nacidas = emptyBucket(), terminadas = emptyBucket(), avances = emptyBucket();
  const nacidasNotas = { F1: [], F2: [], F3: [], "?": [] };
  const terminadasNotas = { F1: [], F2: [], F3: [], "?": [] };
  for (const ev of eventsInWindow) {
    const fase = faseDe(fasePorId, ev.cardId);
    if (ev.type === "born") { nacidas[fase]++; nacidasNotas[fase].push(ev.nota || "?"); }
    else if (ev.type === "terminated") { terminadas[fase]++; terminadasNotas[fase].push(ev.nota || "?"); }
    else if (ev.type === "col_change") {
      const fi = COL_ORDER.indexOf(ev.from), ti = COL_ORDER.indexOf(ev.to);
      if (fi >= 0 && ti > fi) avances[fase]++;
    }
  }
  return { nacidas, terminadas, avances, nacidasNotas, terminadasNotas };
}

export function computeStuckByFase(positions, fasePorId) {
  const now = Date.now();
  const f3 = [], otras = [];
  for (const [id, p] of Object.entries(positions)) {
    if (EXCLUIDOS_VEREDICTO.has(p.status)) continue;
    const dStatus = Math.floor((now - (p.statusSince || p.bornAt)) / DAY_MS);
    if (dStatus <= 5) continue;
    const fase = faseDe(fasePorId, id);
    const rec = { id, ...p, dStatus, fase };
    if (fase === "F3") f3.push(rec);
    else otras.push(rec);
  }
  f3.sort((a, b) => b.dStatus - a.dStatus);
  otras.sort((a, b) => b.dStatus - a.dStatus);
  return { f3, otras };
}

export function computeVerdict(positions, fasePorId) {
  const now = Date.now();
  const f3 = [];
  for (const [id, p] of Object.entries(positions)) {
    if (faseDe(fasePorId, id) !== "F3") continue;
    if (EXCLUIDOS_VEREDICTO.has(p.status)) continue;
    const dVida = Math.floor((now - p.bornAt) / DAY_MS);
    const dStatus = Math.floor((now - (p.statusSince || p.bornAt)) / DAY_MS);
    const cVida = colorVida(dVida), cStatus = colorStatus(dStatus);
    f3.push({ id, ...p, dVida, dStatus, cVida, cStatus, color: peorColor(cVida, cStatus) });
  }
  const rojas = f3.filter(c => c.color === "rojo");
  rojas.sort((a, b) => b.dVida - a.dVida);
  return {
    veredicto: rojas.length === 0 ? "libre" : "oficina",
    f3Count: f3.length,
    rojas,
    amarillas: f3.filter(c => c.color === "amarillo").length,
    verdes: f3.filter(c => c.color === "verde").length,
  };
}

async function fetchEventsRange(env, start, cutoff) {
  // La ventana de 7 dias puede caer entre 2 buckets de friWeekKey. Bajamos ambos.
  const kCutoff = friWeekKey(cutoff);
  const kPrev = friWeekKey(cutoff - 7 * DAY_MS);
  const [a, b] = await Promise.all([
    env.KV.get("events:" + kCutoff),
    kPrev !== kCutoff ? env.KV.get("events:" + kPrev) : Promise.resolve(null),
  ]);
  const all = [...(a ? JSON.parse(a) : []), ...(b ? JSON.parse(b) : [])];
  return all.filter(ev => ev.at > start && ev.at <= cutoff);
}

export async function generateVerdictReport(env, atMs) {
  const cutoff = previousFriday15MX(atMs);
  const start = cutoff - 7 * DAY_MS;
  const [positionsRaw, fasePorId, eventsInWindow, piedraMap] = await Promise.all([
    env.KV.get("positions"),
    fetchFasesFromZoho(env),
    fetchEventsRange(env, start, cutoff),
    fetchPiedrasLGD(env),
  ]);
  const positions = positionsRaw ? JSON.parse(positionsRaw) : {};
  return {
    atMs,
    cutoff,
    start,
    flow: computeFlowWindow(eventsInWindow, fasePorId),
    stuck: computeStuckByFase(positions, fasePorId),
    verdict: computeVerdict(positions, fasePorId),
    falseWaits: computeFalseWaits(positions, piedraMap),
    weekendEvents: eventsInWindow.filter(ev => isWeekendMX(ev.at)),
  };
}

function fmtDateMX(ts) {
  return new Date(ts).toLocaleDateString("es-MX", { day: "numeric", month: "short", weekday: "short", timeZone: "America/Mexico_City" });
}
function fmtTimeMX(ts) {
  return new Date(ts).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" });
}

// Mensaje Telegram (Markdown). Asume reader es Mario.
export function formatVerdictForTelegram(report) {
  const { cutoff, flow, stuck, verdict, weekendEvents } = report;
  const falsas = report.falseWaits || [];
  const totalRojas = verdict.rojas.length + falsas.length;
  const labelStart = cutoff - 4 * DAY_MS - 15 * 60 * 60 * 1000;
  const lines = [];
  lines.push(`*Reporte Forever Us — ${fmtDateMX(cutoff)} ${fmtTimeMX(cutoff)}*`);
  lines.push(`_Semana laboral: ${fmtDateMX(labelStart)} 00:00 → ${fmtDateMX(cutoff)} 15:00 MX_`);
  lines.push("");

  if (totalRojas === 0) {
    lines.push("✅ *SABADO LIBRE* — cero rojas");
  } else {
    lines.push(`🚨 *VIENES A LA OFICINA* — ${totalRojas} roja(s):`);
    for (const c of verdict.rojas) {
      const motivo = c.cVida === "rojo" && c.cStatus === "rojo" ? "vida+status" : c.cVida === "rojo" ? "vida total" : "status";
      lines.push(`  🔴 ${c.nota} (${c.joyeria}) · ${c.col}/${c.status} · vida ${c.dVida}d, status ${c.dStatus}d [${motivo}]`);
    }
    for (const f of falsas) {
      lines.push(`  🚩 ${f.nota} (${f.joyeria}) · ${f.status} pero la piedra YA LLEGÓ (cert ${f.cert}) — espera FALSA`);
    }
  }
  lines.push("");

  if (weekendEvents.length > 0) {
    const notas = [...new Set(weekendEvents.map(e => e.nota).filter(Boolean))];
    lines.push(`📌 *Fin de semana anterior*: ${weekendEvents.length} eventos · ${notas.join(", ")}`);
    lines.push("");
  }

  lines.push(`📥 *Flujo*`);
  lines.push(`  Nacidas: ${totalBucket(flow.nacidas)} (${fmtBucket(flow.nacidas)})`);
  lines.push(`  Terminadas: ${totalBucket(flow.terminadas)} (${fmtBucket(flow.terminadas)})${flow.terminadas["?"] ? "  _(las '?' ya salieron de Diseno en Zoho, presumiblemente F3)_" : ""}`);
  lines.push(`  Avances: ${totalBucket(flow.avances)} (${fmtBucket(flow.avances)})`);
  lines.push("");

  lines.push("⏸ *Estancadas (>5d sin mover status)*");
  if (stuck.f3.length === 0) {
    lines.push("  F3 estricto: 🟢 ninguna");
  } else {
    lines.push("  F3 estricto:");
    for (const c of stuck.f3) lines.push(`    🔴 ${c.nota} · ${c.col}/${c.status} · ${c.dStatus}d`);
  }
  if (stuck.otras.length > 0) {
    lines.push(`  F1/F2 (informativo): ${stuck.otras.length}`);
    for (const c of stuck.otras.slice(0, 5)) lines.push(`    ⏸ ${c.fase} ${c.nota} · ${c.col}/${c.status} · ${c.dStatus}d`);
  }
  return lines.join("\n");
}

export async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Faltan secrets TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID");
  }
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error("Telegram fallo: " + JSON.stringify(j));
  return j;
}

export async function renderReport(env, requestedWeek) {
  const list = await env.KV.list({ prefix: "events:" });
  const weeks = list.keys.map(k => k.name.replace("events:", "")).sort().reverse();
  const week = requestedWeek || weeks[0] || friWeekKey(Date.now());
  if (!weeks.includes(week)) weeks.unshift(week);

  const [events, positionsRaw, narrativeRaw] = await Promise.all([
    env.KV.get("events:" + week),
    env.KV.get("positions"),
    env.KV.get("report:" + week),
  ]);
  const parsedEvents = events ? JSON.parse(events) : [];
  const positions = positionsRaw ? JSON.parse(positionsRaw) : {};

  return renderHTML({
    week,
    weeks,
    metrics: computeMetrics(parsedEvents),
    stuck: computeStuck(positions),
    snapshot: computeSnapshot(positions),
    narrative: narrativeRaw,
  });
}
