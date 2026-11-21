import { parseEvent, step, withEstimates } from "./logic.js";

// ESPN bloque une partie des requêtes venant de Cloudflare (403) : on essaie plusieurs hôtes.
const ESPN_HOSTS = ["https://site.api.espn.com", "https://site.web.api.espn.com"];
const ESPN_PATH = "/apis/site/v2/sports/mma/ufc/scoreboard";
const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");

async function fetchEvents(fromMs, toMs, cacheTtl = 0) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = ESPN_HOSTS[attempt % ESPN_HOSTS.length];
    try {
      const r = await fetch(`${host}${ESPN_PATH}?dates=${ymd(fromMs)}-${ymd(toMs)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ufc-reveil/1.0)", Accept: "application/json" },
        cf: cacheTtl ? { cacheTtlByStatus: { "200-299": cacheTtl, "300-599": 0 } } : undefined,
      });
      if (!r.ok) throw new Error(`ESPN ${r.status}`);
      const d = await r.json();
      return (d.events || []).map(parseEvent).filter((e) => e.fights.length);
    } catch (e) { last = e; }
  }
  throw last;
}

async function publish(env, n) {
  const r = await fetch(env.NTFY_URL || "https://ntfy.sh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(n),
  });
  if (!r.ok) console.log("ntfy", r.status, await r.text());
}

/** Le cron : surveille les événements d'hier à demain et envoie les alertes. */
export async function run(env, now = Date.now()) {
  const events = await fetchEvents(now - DAY, now + DAY);
  const log = [];
  for (const ev of events) {
    const first = Math.min(...ev.fights.map((f) => Date.parse(f.date)));
    const allPre = ev.fights.every((f) => f.state === "pre");
    if (allPre && first - now > 2 * 3600 * 1000) continue; // trop tôt, rien à faire

    const key = `ev:${ev.id}`;
    const prev = await env.STATE.get(key, "json");
    const { state, notes } = step(prev, ev, now);
    for (const n of notes) await publish(env, n);
    if (JSON.stringify(state) !== JSON.stringify(prev))
      await env.STATE.put(key, JSON.stringify(state), { expirationTtl: 4 * DAY / 1000 });
    log.push({ event: ev.name, notes: notes.map((n) => `${n.topic} p${n.priority} ${n.title}`) });
  }
  return log;
}

const json = (data, extra = {}, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", ...extra },
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/events") {
      try {
        const now = Date.now();
        const events = (await fetchEvents(now - DAY, now + 45 * DAY, 30)).map((e) => withEstimates(e, now));
        return json({ now, events }, { "Cache-Control": "public, max-age=30" });
      } catch (e) {
        return json({ error: String(e) }, {}, 502);
      }
    }
    return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not found", { status: 404 });
  },

  async scheduled(_ctrl, env, ctx) {
    ctx.waitUntil(run(env).then((l) => l.forEach((x) => x.notes.length && console.log(JSON.stringify(x)))));
  },
};
