// Spring break flight tracker: Milwaukee area → Puerto Vallarta, 2 adults + 1 child.
// Prices come from Google Flights via SearchApi.io (https://www.searchapi.io/docs/google-flights).
//
//   node flights/collect.mjs --test   3 live calls (one combo), print parsed results, write nothing
//   node flights/collect.mjs --mock   full run with generated prices, no API calls (dashboard testing)
//   node flights/collect.mjs          full run: 75 combos × (nonstop + any stops) + extras,
//                                     append to history.json, write latest.json, send alerts
//
// Env: SEARCHAPI_KEY (required for live runs), NTFY_TOPIC (optional; push alerts),
//      DASHBOARD_URL (optional; link in alerts). Never books anything.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DIR = new URL("./", import.meta.url);
const CONFIG = JSON.parse(readFileSync(new URL("config.json", DIR), "utf8"));
const HISTORY = new URL("history.json", DIR);
const LATEST = new URL("latest.json", DIR);
const MODE = process.argv[2] || "";
const KEY = process.env.SEARCHAPI_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const md = (iso) => iso.slice(5).replace("-", "");

// 5 departure × 5 return dates around the target trip.
function dateCombos() {
  const out = [];
  for (let i = -CONFIG.flexDays; i <= CONFIG.flexDays; i++)
    for (let j = -CONFIG.flexDays; j <= CONFIG.flexDays; j++)
      out.push({ dep: addDays(CONFIG.depart, i), ret: addDays(CONFIG.return, j) });
  return out;
}

// ---- SearchApi
let calls = 0;
async function search(params) {
  const qs = new URLSearchParams({ engine: "google_flights", flight_type: "round_trip", currency: "USD", hl: "en", gl: "us", ...params });
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      calls++;
      const res = await fetch(`https://www.searchapi.io/api/v1/search?${qs}`, { headers: { Authorization: `Bearer ${KEY}` } });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`auth ${res.status}: ${body.error || ""}`), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${body.error || ""}`);
      if (body.error && !/no results|hasn't returned any results/i.test(body.error)) throw new Error(body.error);
      return body;
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e;
      await sleep(4000 * (attempt + 1));
    }
  }
  throw lastErr;
}

const toPrice = (p) => (typeof p === "number" ? p : Number(String(p ?? "").replace(/[^0-9.]/g, "")) || null);

// Itinerary → compact record. Round-trip searches list outbound options, each priced as the
// cheapest round trip that starts with it (per person, since adults=1).
function itin(it) {
  const legs = it.flights || [];
  return {
    price: toPrice(it.price),
    stops: Math.max(0, legs.length - 1),
    airline: [...new Set(legs.map((f) => f.airline).filter(Boolean))].join(" / "),
    flights: legs.map((f) => f.flight_number).filter(Boolean),
    via: (it.layovers || []).map((l) => l.id || l.airport_id || l.name).filter(Boolean),
    dep: legs[0]?.departure_airport?.time || legs[0]?.departure_airport?.date || null,
    token: it.departure_token || null,
  };
}
function cheapest(body) {
  const all = [...(body.best_flights || []), ...(body.other_flights || [])].map(itin).filter((x) => x.price);
  all.sort((a, b) => a.price - b.price);
  return all[0] || null;
}
const insight = (body) => body.price_insights?.price_level || null;

async function combo(origin, c) {
  const base = { departure_id: origin, arrival_id: CONFIG.destination, outbound_date: c.dep, return_date: c.ret, adults: "1" };
  const [ns, any] = await Promise.all([search({ ...base, stops: "nonstop" }), search(base)]);
  const n = cheapest(ns), a = cheapest(any);
  return { origin, dep: c.dep, ret: c.ret, ns: n, any: a, level: insight(any) || insight(ns) };
}

// Return-leg flight numbers for a chosen outbound (one extra call).
async function returnLeg(r) {
  if (!r.ns?.token) return null;
  const body = await search({ departure_id: r.origin, arrival_id: CONFIG.destination, outbound_date: r.dep, return_date: r.ret, adults: "1", stops: "nonstop", departure_token: r.ns.token });
  const back = cheapest(body);
  return back ? { airline: back.airline, flights: back.flights, price: back.price } : null;
}

// Party fare for 2 adults + 1 child on a combo, to see whether the child fare differs.
async function partyFare(r) {
  const body = await search({ departure_id: r.origin, arrival_id: CONFIG.destination, outbound_date: r.dep, return_date: r.ret, stops: "nonstop", adults: String(CONFIG.party.adults), children: String(CONFIG.party.children) });
  const p = cheapest(body);
  return p ? p.price : null;
}

// Simple worker pool so 150+ calls don't all fire at once.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).catch((e) => { if (e.fatal) throw e; return { error: e.message, ...items[k] }; }); }
  }));
  return out;
}

// ---- mock data (deterministic per day) for dashboard testing without API calls
function mockCombo(origin, c, seed) {
  const h = [...`${origin}${c.dep}${c.ret}${seed}`].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rnd = (k) => ((h >>> k) % 1000) / 1000;
  const weekend = [5, 6].includes(new Date(c.dep).getUTCDay()) ? 40 : 0;
  const nsBase = { ORD: 430, MDW: 470, MKE: 0 }[origin];
  const ns = nsBase && rnd(3) > 0.08 ? { price: Math.round(nsBase + weekend + rnd(5) * 160), stops: 0, airline: origin === "MDW" ? "Southwest" : rnd(7) > 0.5 ? "United" : "American", flights: [origin === "MDW" ? "WN 1234" : "UA 1520"], via: [], token: null } : null;
  const anyP = Math.round((ns?.price ?? 560) - 40 + rnd(9) * 170 - (origin === "MKE" ? 0 : 60));
  const any = { price: anyP, stops: ns && anyP >= ns.price ? 0 : 1, airline: origin === "MKE" ? "Delta" : "American", flights: ["DL 1102", "DL 553"], via: ["MSP"], token: null };
  return { origin, dep: c.dep, ret: c.ret, ns, any: ns && any.price >= ns.price ? ns : any, level: ["low", "typical", "high"][Math.floor(rnd(11) * 3)] };
}

// ---- summaries, history, alerts
const key = (r) => `${md(r.dep)}-${md(r.ret)}`;
// A 1-stop option only counts if it beats the same dates' cheapest nonstop by RULE+/person
// (or there is no nonstop on those dates at all).
function overallFor(r) {
  if (!r.any) return r.ns;
  if (!r.ns) return r.any;
  return r.any.stops > 0 && r.any.price <= r.ns.price - CONFIG.oneStopMustBeatBy ? r.any : r.ns;
}
function best(rows, pick) {
  let b = null;
  for (const r of rows) { const x = pick(r); if (x?.price && (!b || x.price < b.price)) b = { ...x, origin: r.origin, dep: r.dep, ret: r.ret, combo: key(r) }; }
  return b;
}
const slim = (b) => b && { price: b.price, origin: b.origin, combo: b.combo, dep: b.dep, ret: b.ret, stops: b.stops, airline: b.airline, flights: b.flights, via: b.via };

function load() {
  return existsSync(HISTORY) ? JSON.parse(readFileSync(HISTORY, "utf8")) : { trip: CONFIG, readings: [] };
}

async function notify(title, lines, priority = "default") {
  const topic = process.env.NTFY_TOPIC;
  console.log(`ALERT ${title}\n  ${lines.join("\n  ")}`);
  if (!topic || MODE === "--mock") return;
  await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: { Title: title, Priority: priority, Tags: "airplane", ...(process.env.DASHBOARD_URL ? { Click: process.env.DASHBOARD_URL } : {}) },
    body: lines.join("\n"),
  }).catch((e) => console.error("ntfy failed:", e.message));
}

async function alerts(h, reading) {
  const R = h.readings, prev = R.at(-2), money = (p) => `$${Math.round(p)}`;
  const desc = (b) => `${b.origin} ${b.dep.slice(5)}→${b.ret.slice(5)} ${b.airline || ""} ${money(b.price)}/pp (${money(b.price * CONFIG.party.size)} for ${CONFIG.party.size})`;

  // 1. A nonstop at or under MAX_PRICE. Re-alert only when it's new or cheaper than last alerted.
  const bn = reading.best.nonstop;
  if (bn && bn.price <= CONFIG.maxPrice) {
    const last = h.alertState?.buyZone;
    if (!last || bn.price < last) await notify(`BUY ZONE: nonstop ${money(bn.price)}/person`, [desc(bn), `At or under your ${money(CONFIG.maxPrice)} max.`], "high");
    h.alertState = { ...h.alertState, buyZone: bn.price };
  } else if (h.alertState?.buyZone) h.alertState = { ...h.alertState, buyZone: null };

  // 2. Best price 10%+ below the trailing average of the previous 7 readings.
  const trail = R.slice(-8, -1);
  for (const [label, k] of [["nonstop", "nonstop"], ["overall", "overall"]]) {
    const now = reading.best[k]?.price, xs = trail.map((r) => r.best[k]?.price).filter(Boolean);
    if (!now || xs.length < 3) continue;
    const avg = xs.reduce((s, x) => s + x, 0) / xs.length;
    if (now <= avg * (1 - CONFIG.alerts.dropBelowAvgPct / 100))
      await notify(`Price drop: best ${label} ${money(now)}/person`, [`${Math.round((1 - now / avg) * 100)}% below the ${xs.length}-reading average (${money(avg)}).`, desc(reading.best[k])]);
  }

  // 3. A combo's nonstops sold out, or its cheapest nonstop jumped 15%+ since the last reading.
  if (prev) {
    const gone = [], jumps = [];
    for (const [o, grid] of Object.entries(reading.grid)) for (const [c, cell] of Object.entries(grid)) {
      const before = prev.grid?.[o]?.[c]?.[0], now = cell[0];
      if (before && !now && !cell[2]) gone.push(`${o} ${c} (was ${money(before)})`);
      else if (before && now && now >= before * (1 + CONFIG.alerts.jumpPct / 100)) jumps.push(`${o} ${c} ${money(before)}→${money(now)}`);
    }
    if (gone.length) await notify(`Nonstops gone on ${gone.length} date combo${gone.length > 1 ? "s" : ""}`, gone.slice(0, 12));
    if (jumps.length) await notify(`Fares jumped ${CONFIG.alerts.jumpPct}%+ on ${jumps.length} combo${jumps.length > 1 ? "s" : ""}`, jumps.slice(0, 12));
  }
}

async function run() {
  const combos = dateCombos();
  const jobs = CONFIG.origins.flatMap((o) => combos.map((c) => ({ origin: o, ...c })));

  if (MODE === "--test") {
    if (!KEY) throw new Error("SEARCHAPI_KEY not set");
    const j = jobs.find((x) => x.origin === "ORD" && x.dep === CONFIG.depart && x.ret === CONFIG.return) || jobs[0];
    const r = await combo(j.origin, j);
    console.log(JSON.stringify({ ...r, ns: r.ns && { ...r.ns, token: !!r.ns.token } }, null, 1));
    console.log("return leg:", JSON.stringify(await returnLeg(r)));
    console.log(`calls used: ${calls}`);
    return;
  }

  const seed = process.env.MOCK_SEED || new Date().toISOString().slice(0, 13);
  const rows = MODE === "--mock"
    ? jobs.map((j) => mockCombo(j.origin, j, seed))
    : await pool(jobs, CONFIG.concurrency, (j) => combo(j.origin, j));
  const failed = rows.filter((r) => r.error);
  if (failed.length > jobs.length / 2) throw new Error(`${failed.length}/${jobs.length} combos failed, e.g. ${failed[0].error}`);

  const bestNs = best(rows, (r) => r.ns), bestAll = best(rows, overallFor);
  // Extras: return-leg flight numbers for each origin's best nonstop, and the 2A+1C party fare.
  const extras = {};
  if (MODE !== "--mock") {
    for (const o of CONFIG.origins) {
      const b = best(rows.filter((r) => r.origin === o), (r) => r.ns);
      if (b) extras[o] = await returnLeg(rows.find((r) => r.origin === o && key(r) === b.combo)).catch(() => null);
    }
    if (bestNs) extras.party = await partyFare(bestNs).catch(() => null);
  } else if (bestNs) extras.party = bestNs.price * 3;

  const t = (MODE === "--mock" && process.env.MOCK_T) || new Date().toISOString();
  const grid = {}; // origin → combo → [cheapest nonstop, cheapest overall (rule applied), stops of overall]
  for (const r of rows) {
    if (r.error) continue;
    const ov = overallFor(r);
    (grid[r.origin] ||= {})[key(r)] = [r.ns?.price ?? null, ov?.price ?? null, ov?.stops ?? null];
  }
  const perOrigin = Object.fromEntries(CONFIG.origins.map((o) => {
    const mine = rows.filter((r) => r.origin === o && !r.error);
    return [o, { nonstop: slim(best(mine, (r) => r.ns)), overall: slim(best(mine, overallFor)) }];
  }));
  const reading = { t, best: { nonstop: slim(bestNs), overall: slim(bestAll) }, perOrigin, grid, party: extras.party ?? null, failed: failed.length, calls };

  const h = load();
  h.trip = CONFIG;
  h.readings.push(reading);
  h.updated = t;
  await alerts(h, reading);
  writeFileSync(HISTORY, JSON.stringify(h) + "\n");
  writeFileSync(LATEST, JSON.stringify({
    t, calls, mock: MODE === "--mock",
    returnLegs: Object.fromEntries(CONFIG.origins.map((o) => [o, extras[o] ?? null])),
    party: extras.party ?? null,
    combos: rows.map((r) => ({ origin: r.origin, dep: r.dep, ret: r.ret, level: r.level ?? null, ns: r.ns && { ...r.ns, token: undefined }, any: r.any && { ...r.any, token: undefined }, error: r.error })),
  }) + "\n");
  console.log(`${t} ${rows.length - failed.length}/${rows.length} combos, ${calls} API calls. Best nonstop ${bestNs ? `$${bestNs.price} ${bestNs.origin} ${bestNs.combo} ${bestNs.airline}` : "none"}; best overall ${bestAll ? `$${bestAll.price} ${bestAll.origin} ${bestAll.combo} (${bestAll.stops} stop)` : "none"}`);
}

await run();
