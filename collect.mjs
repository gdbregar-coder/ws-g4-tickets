// Gametime resale price collector for WS Game 5 (Brewers @ Rays, Oct 28 2026 8:00 PM ET). Game 4 data is in g4/.
//
//   node collect.mjs --dry    one poll, print summary, write nothing (smoke test)
//   node collect.mjs          one poll, append to history.json
//   node collect.mjs --loop   poll every minute until
//                             first pitch or MAX_RUN_MIN elapses; commits+pushes each
//                             reading when running in GitHub Actions.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const EVENT_ID = "6a6e328d86d8e5517d9dd4aa";
const API = (q) => `https://mobile.gametime.co/v3/listings/${EVENT_ID}?all_in_pricing=true&quantity=${q}`;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const END = Date.parse("2026-10-29T00:00:00Z");       // 8:00 PM EDT Oct 28
const MAX_RUN_MIN = Number(process.env.MAX_RUN_MIN || 55);
const FILE = new URL("./history.json", import.meta.url);
const LATEST = new URL("./latest.json", import.meta.url); // every current listing, overwritten each poll
const TOP_N = 5;
const ALERT_UNDER = Number(process.env.ALERT_UNDER || 1000); // $/ticket, preferred 4-together
const ALERT = new URL("./alert.json", import.meta.url);     // listings already alerted on + issue number

// Seat classes. Rows are letters skipping I and O (A..Z then AA..ZZ) or plain numbers.
// Preferred = Sec 100-126 rows 1-23 (A-Y), or any 200s/300s section rows 1-3 (A-C), excluding Party Deck. Mirrored in index.html.
const ROWS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
function rowNum(r) {
  r = String(r).trim().toUpperCase();
  if (/^\d+$/.test(r)) return Number(r);
  const m = r.match(/^([A-Z])\1?$/), i = m ? ROWS.indexOf(m[1]) : -1;
  return i < 0 ? null : i + 1 + (r.length === 2 ? ROWS.length : 0);
}
const isSro = (r) => r.section === "SRO" || r.group === "Standing Room Only";
// Seated = a real assigned seat: numbered section and a normal row. Excludes Party Deck (unassigned),
// section ranges like "314–322" with row TBD, and wheelchair rows (WCH). Mirrored in index.html.
const isAssigned = (r) => /^\d+$/.test(r.section) && rowNum(r.row) != null && r.group !== "Party Deck";
function isPreferred(r) {
  if (!isAssigned(r)) return false;
  const s = Number(r.section), n = rowNum(r.row);
  return (s >= 100 && s <= 126 && n <= 23) || (s >= 200 && s < 400 && n <= 3);
}
// ★★★★ Brewers dugout: the visitors' dugout is on the 3rd-base side in front of odd sections 111-117
// (per a fan seating site; unconfirmed by the Rays). Zone = those plus one section either side, 109-119,
// rows A-Y (first 23), assigned seats only. Mirrored in index.html.
const DUGOUT = { sections: [109, 111, 113, 115, 117, 119], maxRow: 23, alertUnder: 750 };
const isDugout = (r) => isAssigned(r) && DUGOUT.sections.includes(Number(r.section)) && rowNum(r.row) <= DUGOUT.maxRow;
// Cheapest of a (price-sorted) subset.
const low = (rs) => ({ min: rs[0]?.price ?? null, section: rs[0]?.section ?? "", row: rs[0]?.row ?? "", count: rs.length });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const intervalAt = () => 60_000;

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}

async function fetchQty(q) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API(q), { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const listings = (await res.json()).listings || [];
      const rows = listings
        .filter((l) => l?.price?.total > 0)
        .map((l) => ({
          price: Math.round(l.price.total / 100), // per ticket, all-in, dollars
          section: l.spot?.section ?? "",
          row: l.spot?.row ?? "",
          group: l.spot?.section_group ?? "",
        }))
        .sort((a, b) => a.price - b.price);
      const prices = rows.map((r) => r.price);
      // Cheapest listing per seating level (Gametime section_group); rows are sorted, so first seen = cheapest.
      const levels = {};
      for (const r of rows) {
        const k = r.group || "Other";
        if (!levels[k]) levels[k] = { min: r.price, section: r.section, row: r.row, count: 0 };
        levels[k].count++;
      }
      const summary = { count: rows.length, min: prices[0] ?? null, p25: pct(prices, 0.25), median: pct(prices, 0.5), top: rows.slice(0, TOP_N), levels,
        seated: low(rows.filter(isAssigned)), sro: low(rows.filter(isSro)), pref: low(rows.filter(isPreferred)), dug: low(rows.filter(isDugout)),
        prefList: rows.filter(isPreferred).map((r) => [r.price, r.section, r.row]) }; // per-listing, for drop detection
      return { summary, rows };
    } catch (e) {
      lastErr = e;
      await sleep(15_000);
    }
  }
  throw new Error(`q=${q}: ${lastErr.message}`);
}

// Returns the history reading plus every listing (compact) for latest.json.
async function poll() {
  const [q1, q2, q4] = await Promise.all([fetchQty(1), fetchQty(2), fetchQty(4)]);
  const t = new Date().toISOString();
  const compact = (rows) => rows.map((r) => [r.price, r.section, r.row, r.group]);
  return { reading: { t, q1: q1.summary, q2: q2.summary, q4: q4.summary }, latest: { t, fields: ["price", "section", "row", "group"], q1: compact(q1.rows), q2: compact(q2.rows), q4: compact(q4.rows) } };
}

function load() {
  if (!existsSync(FILE)) return { event: { id: EVENT_ID, name: "World Series Game 5 · Brewers @ Rays", start: "2026-10-29T00:00:00Z" }, readings: [] };
  return JSON.parse(readFileSync(FILE, "utf8"));
}

function append(reading) {
  const h = load();
  h.readings.push(reading);
  h.updated = reading.t;
  writeFileSync(FILE, JSON.stringify(h, null, 1) + "\n");
}

// Alert: a GitHub issue that @-mentions the repo owner (GitHub app push notification).
// One issue for the day; a comment for each preferred 4-together listing under ALERT_UNDER not alerted before.
async function gh(path, body) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
  return res.json();
}
// ★★★★ dugout alert: each new 4-together listing in the dugout zone under DUGOUT.alertUnder, once each.
async function dugoutAlert(latest) {
  if (!process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  const state = existsSync(ALERT) ? JSON.parse(readFileSync(ALERT, "utf8")) : { issue: null, seen: [] };
  const key = ([price, section, row]) => `${price}|${section}|${row}`, seen = state.dugSeen || [];
  const fresh = latest.q4.filter(([price, section, row, group]) => price < DUGOUT.alertUnder && isDugout({ section, row, group }) && !seen.includes(key([price, section, row])));
  if (!fresh.length) return;
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const page = `https://${owner}.github.io/${process.env.GITHUB_REPOSITORY.split("/")[1]}/`;
  const at = new Date(latest.t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  const lines = fresh.map(([price, section, row]) => `- **$${price}/ticket** · Sec ${section} Row ${row} · 4 together`).join("\n");
  const body = `@${owner} ★★★★ Brewers dugout 4-pack under $${DUGOUT.alertUnder} (Gametime, ${at} ET):\n\n${lines}\n\n${page}`;
  try {
    if (!state.dugIssue) state.dugIssue = (await gh("/issues", { title: `★★★★ Brewers dugout 4-pack under $${DUGOUT.alertUnder}`, body })).number;
    else await gh(`/issues/${state.dugIssue}/comments`, { body });
    state.dugSeen = [...seen, ...fresh.map(key)];
    writeFileSync(ALERT, JSON.stringify(state) + "\n");
    console.log(`dugout alert: ${fresh.length} listing(s)`);
  } catch (e) { console.error("dugout alert failed:", e.message); }
}

async function alert(latest) {
  if (!process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  const state = existsSync(ALERT) ? JSON.parse(readFileSync(ALERT, "utf8")) : { issue: null, seen: [] };
  const key = ([price, section, row]) => `${price}|${section}|${row}`;
  const hits = latest.q4.filter(([price, section, row, group]) => price < ALERT_UNDER && isPreferred({ section, row, group }));
  const fresh = hits.filter((h) => !state.seen.includes(key(h)));
  if (!fresh.length) return;
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const lines = fresh.map(([price, section, row, group]) => `- **$${price}/ticket** · Sec ${section} Row ${row} (${group}) · 4 together`).join("\n");
  const page = `https://${owner}.github.io/${process.env.GITHUB_REPOSITORY.split("/")[1]}/`;
  const body = `@${owner} preferred 4-together under $${ALERT_UNDER} (Gametime, ${new Date(latest.t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET):\n\n${lines}\n\n${page}`;
  try {
    if (!state.issue) state.issue = (await gh("/issues", { title: `Preferred 4-together under $${ALERT_UNDER}`, body })).number;
    else await gh(`/issues/${state.issue}/comments`, { body });
    state.seen.push(...fresh.map(key));
    writeFileSync(ALERT, JSON.stringify(state) + "\n");
    console.log(`alerted: ${fresh.length} listing(s)`);
  } catch (e) { console.error("alert failed:", e.message); }
}

// Market trend (mirrors index.html): 4-together 25th pct -> 5-reading rolling median -> time-aware Holt
// linear trend. "watch" = slope > +2%/hr for 10 min ("Turning up", page only); "rising" = > +3%/hr for
// 15 min and at least 3% above the day's lowest trend level (a meaningful upturn; this is what alerts).
const TREND = { alpha: 0.08, beta: 0.03, win: 5, fallPct: -1, watch: [2, 10], rise: [3, 15], riseOffLow: 3 };
function marketTrend(R) {
  const pts = [], buf = [];
  let lvl = null, slope = 0, prev = null;
  for (const r of R) {
    const t = Date.parse(r.t), raw = r.q4?.p25;
    if (raw == null) continue;
    buf.push(raw); if (buf.length > TREND.win) buf.shift();
    const y = [...buf].sort((a, b) => a - b)[Math.floor(buf.length / 2)];
    if (lvl == null) { lvl = y; prev = t; pts.push({ t, lvl, slope }); continue; }
    const dt = Math.max(1, (t - prev) / 60000); prev = t;
    const a = 1 - (1 - TREND.alpha) ** dt, b = 1 - (1 - TREND.beta) ** dt;
    const next = a * y + (1 - a) * (lvl + slope * dt);
    slope = b * (next - lvl) / dt + (1 - b) * slope; lvl = next;
    pts.push({ t, lvl, slope });
  }
  const pct = (p) => (p.slope * 60) / p.lvl * 100, held = (min) => {
    let since = null;
    for (const p of pts) since = pct(p) >= min ? since ?? p.t : null;
    return since == null ? 0 : (pts.at(-1).t - since) / 60000;
  };
  const last = pts.at(-1), now = last ? pct(last) : 0, low = Math.min(...pts.map((p) => p.lvl));
  const state = !last || pts.length < TREND.win ? "flat"
    : held(TREND.rise[0]) >= TREND.rise[1] && last.lvl >= low * (1 + TREND.riseOffLow / 100) ? "rising"
    : held(TREND.watch[0]) >= TREND.watch[1] ? "watch"
    : now <= TREND.fallPct ? "falling" : "flat";
  return { last, perHr: last ? last.slope * 60 : 0, pctHr: now, offLow: last ? (last.lvl / low - 1) * 100 : 0, state };
}

// CUSUM change detector (independent check on the upturn). Input: per-minute log change of the
// 4-together 25th pct. Each change is divided by today's own noise (sigma = 1.4826 x MAD of the last
// 120 changes, floored at 0.2%/min), clipped to +/-3 so one spike can't trip it, and accumulated:
// S = max(0, S + z - k). It fires when S >= h. k = 1 (looks for a shift of ~2x normal noise), h = 5.
// Backtest: Game 4 fires once at 6:31 PM; Game 5 none so far. h = 6 misses Game 4; h = 4 also flags
// the 5:43 PM blip, so it's a second opinion next to the Holt rule, not a replacement.
const CUSUM = { k: 1, h: 5, win: 120, minN: 30, clip: 3, floor: 0.002 };
function cusumUp(R) {
  const med = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
  const xs = R.filter((r) => r.q4?.p25 != null).map((r) => ({ t: Date.parse(r.t), x: r.q4.p25 }));
  const rets = [];
  let S = 0, sig = null, firedAt = null;
  for (let i = 1; i < xs.length; i++) {
    const dt = Math.max(1, (xs[i].t - xs[i - 1].t) / 60000), r = Math.log(xs[i].x / xs[i - 1].x) / Math.sqrt(dt);
    const hist = rets.slice(-CUSUM.win);
    rets.push(r);
    if (hist.length < CUSUM.minN) continue;
    const m = med(hist);
    sig = Math.max(1.4826 * med(hist.map((v) => Math.abs(v - m))), CUSUM.floor);
    S = Math.max(0, S + Math.max(-CUSUM.clip, Math.min(CUSUM.clip, r / sig)) - CUSUM.k);
    if (S >= CUSUM.h) firedAt = xs[i].t;
  }
  // The score drains back under h within minutes, so also report when it last fired.
  const last = xs.at(-1)?.t ?? 0, recent = (min) => firedAt != null && last - firedAt <= min * 60000;
  return { S, h: CUSUM.h, sig, firedAt, fired: recent(10), shown: recent(60) };
}

// Alert when either detector says the market turned up (Holt "rising" or CUSUM), naming which one, then
// one follow-up when the other agrees. Re-arms only after the Holt trend is falling again, so wobble
// around the turn doesn't send repeat pings. Separate issue from the listing alerts.
async function trendAlert(latest) {
  if (!process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY) return;
  const state = existsSync(ALERT) ? JSON.parse(readFileSync(ALERT, "utf8")) : { issue: null, seen: [] };
  const R = load().readings, m = marketTrend(R), c = cusumUp(R);
  if (m.state === "falling" && state.trendUp) { state.trendUp = false; state.trendSignals = []; writeFileSync(ALERT, JSON.stringify(state) + "\n"); }
  const now = [...(m.state === "rising" ? ["holt"] : []), ...(c.fired ? ["cusum"] : [])];
  const fresh = now.filter((k) => !(state.trendSignals || []).includes(k));
  if (!fresh.length) return;
  const owner = process.env.GITHUB_REPOSITORY_OWNER, $ = (v) => "$" + Math.round(v).toLocaleString("en-US");
  const page = `https://${owner}.github.io/${process.env.GITHUB_REPOSITORY.split("/")[1]}/`;
  const at = new Date(latest.t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
  const seat = latest.q4.find(([, section, row, group]) => isAssigned({ section, row, group }));
  const pref = latest.q4.find(([, section, row, group]) => isPreferred({ section, row, group }));
  const why = { holt: `trend line rising ${m.pctHr.toFixed(1)}%/hr, ${m.offLow.toFixed(1)}% above today's low`,
    cusum: `CUSUM: an unusually large upward move for today's noise (score ${c.S.toFixed(1)} ≥ ${c.h})` };
  const head = state.trendUp
    ? `@${owner} upturn **confirmed by both checks** (${at} ET): ${fresh.map((k) => why[k]).join("; ")}.`
    : `@${owner} market is **turning up meaningfully** (${at} ET): ${now.map((k) => why[k]).join("; ")}.`;
  const body = `${head}\n\n4 together, 25th pct trend: ${$(m.last.lvl)} (▲${$(m.perHr)}/hr).\n` +
    (pref ? `- Cheapest preferred 4 together: **$${pref[0]}** · Sec ${pref[1]} Row ${pref[2]}\n` : "") +
    (seat ? `- Cheapest real seat 4 together: **$${seat[0]}** · Sec ${seat[1]} Row ${seat[2]}\n` : "") + `\n${page}`;
  try {
    if (!state.trendIssue) state.trendIssue = (await gh("/issues", { title: "Market trend turning up", body })).number;
    else await gh(`/issues/${state.trendIssue}/comments`, { body });
    state.trendUp = true; state.trendSignals = [...new Set([...(state.trendSignals || []), ...now])];
    writeFileSync(ALERT, JSON.stringify(state) + "\n");
    console.log(`trend alert: ${now.join("+")}`);
  } catch (e) { console.error("trend alert failed:", e.message); }
}

// Pushes made with the Actions token don't fire push workflows, so start the site deploy (pages.yml) ourselves.
function deploy() {
  try { execSync("gh workflow run pages.yml --ref main", { stdio: "inherit" }); }
  catch (e) { console.error("deploy trigger failed:", e.message); }
}

function publish(reading) {
  if (!process.env.GITHUB_ACTIONS) return;
  const sh = (c) => execSync(c, { stdio: "inherit" });
  sh(`git add history.json latest.json${existsSync(ALERT) ? " alert.json" : ""}`);
  execSync("git commit -q -F -", { input: `reading ${reading.t} q4 low $${reading.q4.min} q2 low $${reading.q2.min}\n`, stdio: ["pipe", "inherit", "inherit"] });
  for (let i = 0; i < 4; i++) {
    try { sh("git pull -q --rebase origin main && git push -q origin HEAD:main"); deploy(); return; }
    catch { execSync("sleep 5"); }
  }
  throw new Error("push failed");
}

const summary = (r) =>
  `${r.t}  4-together: ${r.q4.count} listings, low $${r.q4.min} (Sec ${r.q4.top[0]?.section} Row ${r.q4.top[0]?.row}), med $${r.q4.median}  |  ` +
  `pairs: ${r.q2.count} listings, low $${r.q2.min}, med $${r.q2.median}`;

async function once(write) {
  const { reading: r, latest } = await poll();
  console.log(summary(r));
  if (r.q2.count === 0 && r.q4.count === 0) throw new Error("no listings returned");
  if (write) { append(r); writeFileSync(LATEST, JSON.stringify(latest) + "\n"); await alert(latest); await dugoutAlert(latest); await trendAlert(latest); publish(r); }
  return r;
}

async function loop() {
  const stopAt = Math.min(END, Date.now() + MAX_RUN_MIN * 60_000);
  while (Date.now() < stopAt) {
    const last = load().readings.at(-1);
    const now = Date.now();
    const iv = intervalAt(now);
    // Due if no reading in the current wall-clock slot (slots aligned to :00/:10/... or :05).
    const slotStart = Math.floor(now / iv) * iv;
    if (!last || Date.parse(last.t) < slotStart - 15_000) {
      try { await once(true); } catch (e) { console.error("poll failed:", e.message); }
    }
    const next = Math.floor(Date.now() / intervalAt(Date.now())) * intervalAt(Date.now()) + intervalAt(Date.now());
    if (next >= stopAt) break;
    await sleep(Math.max(5_000, next - Date.now() + 2_000));
    if (process.env.GITHUB_ACTIONS) execSync("git pull -q --rebase origin main", { stdio: "inherit" });
  }
  console.log("loop done");
}

const arg = process.argv[2];
if (arg === "--loop") await loop();
else await once(arg !== "--dry");
