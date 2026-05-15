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
// IMPRESO/NO NECESITA en confirmado son terminales: ya cerro el flujo de diseño,
// solo falta apretar "Enviar a Vaciado" para cerrarla. No se cuentan como
// estancadas. El evento "terminated" lo emite solo el boton.
const TERMINAL = { confirmado: ["IMPRESO", "NO NECESITA"] };

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
