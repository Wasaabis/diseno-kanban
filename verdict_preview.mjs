// Reporte semanal Forever Us — flujo + estancadas + veredicto sabado.
// Reglas en: ~/.claude/projects/C--Users-arman-forever-us/memory/project_veredicto_armando_criterios.md
// Corte: lunes 00:00 MX → viernes 15:00 MX. Trigger real: cron `0 21 * * 5`.
//
// ⚠ ESTO ES UNA COPIA PARALELA DE LAS REGLAS, NO LA FUENTE DE VERDAD.
// Quien decide el veredicto real es `src/report.js` (lo corre el cron del viernes).
// Esta copia ya se habia desincronizado una vez (2026-08-12: le faltaban los estados
// excluidos nuevos y los dos detectores de trampa), asi que daba un resultado
// distinto al que llegaba por Telegram. Para un preview FIEL usa el endpoint:
//     curl -H "Cookie: kb_auth=<PIN>" "<worker>/report/verdict"
// Si tocas las reglas en report.js y no aqui, este script vuelve a mentir.
const WORKER = "https://kanban-disetight-band-76ce.contacto-ed2.workers.dev";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 3600 * 1000;

const COL_ORDER = ["diseno", "envio", "confirmado"];
const EXCLUIDOS = new Set([
  "ESPERA - GEMA", "ESPERA - MTTO", "ESPERA",
  "IMPRESO", "NO NECESITA", "IMPRIMIENDO",
  "ENVIADO", "CON CLIENTE",
]);

function colorVida(d) { return d <= 7 ? "verde" : d <= 12 ? "amarillo" : "rojo"; }
function colorStatus(d) { return d <= 3 ? "verde" : d <= 5 ? "amarillo" : "rojo"; }
function peor(a, b) {
  const rank = { verde: 0, amarillo: 1, rojo: 2 };
  return rank[a] >= rank[b] ? a : b;
}

// Vie 15:00 MX = vie 21:00 UTC. Busca el ultimo viernes 15:00 MX <= now.
function previousFriday15MX(nowMs) {
  for (let i = 0; i < 14; i++) {
    const candidate = new Date(nowMs - i * DAY_MS);
    // Pasar a "dia MX" restando 6h (MX UTC-6 fijo)
    const mx = new Date(candidate.getTime() - 6 * HOUR_MS);
    if (mx.getUTCDay() === 5) {
      const y = mx.getUTCFullYear(), m = mx.getUTCMonth(), d = mx.getUTCDate();
      const fri15 = Date.UTC(y, m, d, 21, 0, 0); // 21:00 UTC = 15:00 MX
      if (fri15 <= nowMs) return fri15;
    }
  }
  throw new Error("no friday found");
}

// friWeekKey usado por el worker para sus buckets de events (lo dejamos asi por compatibilidad).
function friWeekKey(ts) {
  const mx = new Date(ts - 6 * HOUR_MS);
  const daysSinceFri = (mx.getUTCDay() - 5 + 7) % 7;
  const friday = new Date(mx.getTime() - daysSinceFri * DAY_MS);
  const y = friday.getUTCFullYear();
  const m = String(friday.getUTCMonth() + 1).padStart(2, "0");
  const d = String(friday.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function fmtDateMX(ts) {
  return new Date(ts).toLocaleDateString("es-MX", {
    day: "numeric", month: "short", weekday: "short", timeZone: "America/Mexico_City"
  });
}
function fmtTimeMX(ts) {
  return new Date(ts).toLocaleTimeString("es-MX", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City"
  });
}

// ─── Ventana entre cortes (7 dias exactos) ────────────────────────────
// Se mide vie 15:00 anterior → vie 15:00 actual para no perder eventos del sab/dom
// si Armando vino excepcionalmente. El titulo dice "lun→vie" porque es lo normal.
const now = Date.now();
const cutoff = previousFriday15MX(now);          // vie 15:00 MX mas reciente (<= now)
const start = cutoff - 7 * DAY_MS;               // vie 15:00 MX anterior
const labelStart = cutoff - 4 * DAY_MS - 15 * HOUR_MS; // lun 00:00 MX (solo para titulo)

// ─── Bajar datos en paralelo ──────────────────────────────────────────
// La ventana puede cruzar 2 buckets de events (vie pasado y vie de esta semana).
const bucketActual = friWeekKey(cutoff);
const bucketAnterior = friWeekKey(cutoff - 7 * DAY_MS);
const [posR, tokR, evCurR, evPrevR] = await Promise.all([
  fetch(`${WORKER}/kv?key=positions`).then(r => r.json()),
  fetch(`${WORKER}/token`).then(r => r.json()),
  fetch(`${WORKER}/events?week=${bucketActual}`).then(r => r.json()),
  fetch(`${WORKER}/events?week=${bucketAnterior}`).then(r => r.json()),
]);
const positions = JSON.parse(posR.value);
const accessToken = tokR.access_token;
if (!accessToken) { console.error("Sin token Zoho"); process.exit(1); }

const zohoUrl = "https://www.zohoapis.com/crm/v2/Quotes/search?criteria=(Etapa:equals:Dise%C3%B1o)&per_page=200";
const zR = await fetch(`${WORKER}/zoho?url=${encodeURIComponent(zohoUrl)}`, {
  headers: { Authorization: "Zoho-oauthtoken " + accessToken }
});
const records = (await zR.json()).data || [];
const fasePorId = {};
for (const r of records) {
  const m = (r.Fases || "").match(/(\d)/);
  fasePorId[r.id] = m ? `F${m[1]}` : null;
}

// Eventos dentro de la ventana vie→vie (7 dias)
const eventsAll = [...(Array.isArray(evPrevR) ? evPrevR : []), ...(Array.isArray(evCurR) ? evCurR : [])];
const events = eventsAll.filter(ev => ev.at > start && ev.at <= cutoff);

// Eventos del fin de semana anterior (sab/dom MX) — excepcion a destacar
function isWeekendMX(ts) {
  const mx = new Date(ts - 6 * HOUR_MS);
  const dow = mx.getUTCDay();
  return dow === 6 || dow === 0; // sab=6, dom=0
}
const eventosFinDeSemana = events.filter(ev => isWeekendMX(ev.at));

// ─── Helpers ──────────────────────────────────────────────────────────
function faseDe(cardId) { return fasePorId[cardId] || "?"; }
function bucketPorFase() { return { F1: 0, F2: 0, F3: 0, "?": 0 }; }
function addToBucket(b, fase) { b[fase] = (b[fase] || 0) + 1; }
function fmtBucket(b) {
  return `F1: ${b.F1} · F2: ${b.F2} · F3: ${b.F3}` + (b["?"] ? ` · ?: ${b["?"]}` : "");
}

// ─── Flujo ────────────────────────────────────────────────────────────
const nacidas = bucketPorFase(), terminadas = bucketPorFase(), avances = bucketPorFase();
const nacidasNotas = { F1: [], F2: [], F3: [], "?": [] };
const terminadasNotas = { F1: [], F2: [], F3: [], "?": [] };
for (const ev of events) {
  const fase = faseDe(ev.cardId);
  if (ev.type === "born") {
    addToBucket(nacidas, fase);
    nacidasNotas[fase].push(ev.nota || "?");
  } else if (ev.type === "terminated") {
    addToBucket(terminadas, fase);
    terminadasNotas[fase].push(ev.nota || "?");
  } else if (ev.type === "col_change") {
    const fi = COL_ORDER.indexOf(ev.from), ti = COL_ORDER.indexOf(ev.to);
    if (fi >= 0 && ti > fi) addToBucket(avances, fase);
  }
}

// ─── Estancadas por status actual (snapshot now) ──────────────────────
const estancadasF3 = [], estancadasOtras = [];
for (const [id, p] of Object.entries(positions)) {
  if (EXCLUIDOS.has(p.status)) continue;
  const dStatus = Math.floor((now - (p.statusSince || p.bornAt)) / DAY_MS);
  if (dStatus <= 5) continue;
  const fase = faseDe(id);
  const rec = { id, ...p, dStatus, fase };
  if (fase === "F3") estancadasF3.push(rec);
  else estancadasOtras.push(rec);
}
estancadasF3.sort((a, b) => b.dStatus - a.dStatus);
estancadasOtras.sort((a, b) => b.dStatus - a.dStatus);

// ─── Veredicto F3 (snapshot now) ──────────────────────────────────────
const f3 = [];
for (const [id, p] of Object.entries(positions)) {
  if (faseDe(id) !== "F3") continue;
  if (EXCLUIDOS.has(p.status)) continue;
  const dVida = Math.floor((now - p.bornAt) / DAY_MS);
  const dStatus = Math.floor((now - (p.statusSince || p.bornAt)) / DAY_MS);
  const cVida = colorVida(dVida), cStatus = colorStatus(dStatus);
  f3.push({ id, ...p, dVida, dStatus, cVida, cStatus, color: peor(cVida, cStatus) });
}
const rojas = f3.filter(c => c.color === "rojo");
rojas.sort((a, b) => b.dVida - a.dVida);

// ─── Render ───────────────────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════════════════════════════");
console.log(`  REPORTE SEMANAL FOREVER US — corte ${fmtDateMX(cutoff)} ${fmtTimeMX(cutoff)} hrs`);
console.log(`  Semana laboral: ${fmtDateMX(labelStart)} 00:00 → ${fmtDateMX(cutoff)} 15:00 MX`);
console.log("═══════════════════════════════════════════════════════════════════════════\n");

if (eventosFinDeSemana.length > 0) {
  console.log(`📌 EXCEPCION: Armando vino el fin de semana anterior — ${eventosFinDeSemana.length} eventos`);
  // Listar notas unicas tocadas
  const notasFinDe = [...new Set(eventosFinDeSemana.map(e => e.nota).filter(Boolean))];
  if (notasFinDe.length) console.log(`   Tarjetas tocadas: ${notasFinDe.join(", ")}`);
  console.log();
}

console.log("📥 FLUJO DE LA SEMANA");
const totalNac = nacidas.F1+nacidas.F2+nacidas.F3+nacidas["?"];
const totalTerm = terminadas.F1+terminadas.F2+terminadas.F3+terminadas["?"];
const totalAv = avances.F1+avances.F2+avances.F3+avances["?"];
console.log(`   Nacidas:    ${String(totalNac).padStart(2)}   → ${fmtBucket(nacidas)}`);
console.log(`   Terminadas: ${String(totalTerm).padStart(2)}   → ${fmtBucket(terminadas)}${terminadas["?"] ? "   (las '?' ya salieron de Diseno en Zoho, presumiblemente F3)" : ""}`);
console.log(`   Avances:    ${String(totalAv).padStart(2)}   → ${fmtBucket(avances)}`);
if (nacidasNotas.F3.length) console.log(`     · nacidas F3: ${nacidasNotas.F3.join(", ")}`);
if (terminadasNotas.F3.length) console.log(`     · terminadas F3: ${terminadasNotas.F3.join(", ")}`);
console.log();

console.log("⏸  ESTANCADAS POR STATUS ACTUAL (>5d sin mover el status, snapshot al corte)");
console.log("   ── F3 (estricto, motivan veredicto):");
if (estancadasF3.length === 0) console.log("      🟢 ninguna");
else for (const c of estancadasF3) console.log(`      🔴 ${c.nota.padEnd(8)} ${c.joyeria.padEnd(15)} ${c.col}/${c.status.padEnd(13)} status=${c.dStatus}d`);
console.log("   ── F1/F2 (informativo, NO fuerzan oficina):");
if (estancadasOtras.length === 0) console.log("      (ninguna)");
else for (const c of estancadasOtras) console.log(`      ⏸  ${c.fase} ${c.nota.padEnd(8)} ${c.joyeria.padEnd(15)} ${c.col}/${c.status.padEnd(13)} status=${c.dStatus}d`);
console.log();

console.log("🚨 VEREDICTO ARMANDO — sabado (F3, semaforo vida+status)");
console.log(`   F3 evaluadas: ${f3.length}   |   rojas: ${rojas.length}`);
if (rojas.length === 0) {
  console.log("\n   ✅✅✅  SABADO LIBRE  ✅✅✅");
} else {
  console.log("\n   🚨🚨🚨  VIENES A LA OFICINA  🚨🚨🚨");
  console.log("   (cuando se active el modulo de chat, se evaluara culpa cliente/tienda/Armando)\n");
  for (const c of rojas) {
    const motivo = c.cVida === "rojo" && c.cStatus === "rojo" ? "vida+status" : c.cVida === "rojo" ? "vida total" : "status";
    console.log(`   🔴 ${c.nota.padEnd(8)} ${c.joyeria.padEnd(15)} ${c.col}/${c.status.padEnd(13)} vida=${c.dVida}d status=${c.dStatus}d  [${motivo}]`);
  }
}
