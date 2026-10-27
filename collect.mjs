// Gametime resale price collector for WS Game 4 (Brewers @ Rays, Oct 27 2026 8:00 PM ET).
//
//   node collect.mjs --dry    one poll, print summary, write nothing (smoke test)
//   node collect.mjs          one poll, append to history.json
//   node collect.mjs --loop   poll on schedule (10 min, 5 min after 6:30 PM ET) until
//                             first pitch or MAX_RUN_MIN elapses; commits+pushes each
//                             reading when running in GitHub Actions.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const EVENT_ID = "6a6e328da480127e6660ba09";
const API = (q) => `https://mobile.gametime.co/v3/listings/${EVENT_ID}?all_in_pricing=true&quantity=${q}`;
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const END = Date.parse("2026-10-28T00:00:00Z");       // 8:00 PM EDT
const FAST_FROM = Date.parse("2026-10-27T22:30:00Z"); // 6:30 PM EDT
const MAX_RUN_MIN = Number(process.env.MAX_RUN_MIN || 55);
const FILE = new URL("./history.json", import.meta.url);
const TOP_N = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const intervalAt = (t) => (t >= FAST_FROM ? 5 : 10) * 60_000;

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
      return { count: rows.length, min: prices[0] ?? null, p25: pct(prices, 0.25), median: pct(prices, 0.5), top: rows.slice(0, TOP_N), levels };
    } catch (e) {
      lastErr = e;
      await sleep(15_000);
    }
  }
  throw new Error(`q=${q}: ${lastErr.message}`);
}

async function poll() {
  const [q2, q4] = await Promise.all([fetchQty(2), fetchQty(4)]);
  return { t: new Date().toISOString(), q2, q4 };
}

function load() {
  if (!existsSync(FILE)) return { event: { id: EVENT_ID, name: "World Series Game 4 · Brewers @ Rays", start: "2026-10-28T00:00:00Z" }, readings: [] };
  return JSON.parse(readFileSync(FILE, "utf8"));
}

function append(reading) {
  const h = load();
  h.readings.push(reading);
  h.updated = reading.t;
  writeFileSync(FILE, JSON.stringify(h, null, 1) + "\n");
}

function publish(reading) {
  if (!process.env.GITHUB_ACTIONS) return;
  const sh = (c) => execSync(c, { stdio: "inherit" });
  sh("git add history.json");
  execSync("git commit -q -F -", { input: `reading ${reading.t} q4 low $${reading.q4.min} q2 low $${reading.q2.min}\n`, stdio: ["pipe", "inherit", "inherit"] });
  for (let i = 0; i < 4; i++) {
    try { sh("git pull -q --rebase origin main && git push -q origin HEAD:main"); return; }
    catch { execSync("sleep 5"); }
  }
  throw new Error("push failed");
}

const summary = (r) =>
  `${r.t}  4-together: ${r.q4.count} listings, low $${r.q4.min} (Sec ${r.q4.top[0]?.section} Row ${r.q4.top[0]?.row}), med $${r.q4.median}  |  ` +
  `pairs: ${r.q2.count} listings, low $${r.q2.min}, med $${r.q2.median}`;

async function once(write) {
  const r = await poll();
  console.log(summary(r));
  if (r.q2.count === 0 && r.q4.count === 0) throw new Error("no listings returned");
  if (write) { append(r); publish(r); }
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
    if (!last || Date.parse(last.t) < slotStart - 30_000) {
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
