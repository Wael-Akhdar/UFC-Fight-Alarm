// Logique pure (aucun accès réseau) : parsing ESPN, estimation d'horaires,
// et décision des notifications à envoyer. Testable avec `node --test`.

export const TOPIC_PREFIX = "ufc-reveil-";
export const topicFor = (fightId) => TOPIC_PREFIX + fightId;

const FIGHT_MIN = 22 * 60 * 1000; // durée moyenne "combat + entre-deux" sur une carte UFC
const NAG_MAX = 3; // nb total de notifs urgentes envoyées pour le réveil

export function parseEvent(e) {
  const fights = (e.competitions || []).map((c) => {
    const st = c.status || {};
    const t = st.type || {};
    const comps = [...(c.competitors || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
    return {
      id: String(c.id),
      date: c.date,
      weight: (c.type && c.type.abbreviation) || "",
      names: comps.map((x) => (x.athlete && x.athlete.displayName) || "?"),
      records: comps.map((x) => ((x.records || [])[0] || {}).summary || ""),
      winner: comps.findIndex((x) => x.winner),
      state: t.state || "pre", // pre | in | post
      status: t.name || "",
      detail: t.detail || "",
      round: st.period || 0,
      clock: st.displayClock || "",
      topic: topicFor(c.id),
    };
  });
  return { id: String(e.id), name: e.name || "", date: e.date, fights };
}

export const label = (f) => f.names.join(" vs ");
export const isCancelled = (f) =>
  /CANCEL|POSTPONED|NO_CONTEST_PRE/i.test(f.status) || /cancel/i.test(f.detail);

/** Ajoute à chaque combat une heure de début estimée (ms epoch). */
export function withEstimates(event, now = Date.now()) {
  const active = event.fights.filter((f) => !isCancelled(f));
  const liveIdx = active.findIndex((f) => f.state === "in");
  const lastDone = active.map((f) => f.state).lastIndexOf("post");
  const started = liveIdx >= 0 || lastDone >= 0;
  active.forEach((f, i) => {
    if (f.state !== "pre") return void (f.est = null);
    if (started) {
      // à partir de maintenant : le combat en cours compte pour une moitié
      // combat en cours : il lui reste ~1/2 combat ; sinon le prochain = walkouts (~0.3 combat)
      const ahead = liveIdx >= 0 ? i - liveIdx - 0.5 : i - lastDone - 1 + 0.3;
      f.est = Math.max(now, now + ahead * FIGHT_MIN);
    } else {
      // avant la soirée : début du segment (prelims / main card) + position dans le segment
      const segStart = Date.parse(f.date);
      const k = active.slice(0, i).filter((g) => g.date === f.date).length;
      f.est = segStart + k * FIGHT_MIN;
    }
  });
  // une estimation ne peut pas précéder celle du combat d'avant
  for (let i = 1; i < active.length; i++) {
    if (active[i].est && active[i - 1].est && active[i].est < active[i - 1].est + 10 * 60000)
      active[i].est = active[i - 1].est + FIGHT_MIN;
  }
  return event;
}

const note = (f, title, message, priority, tags) => ({ topic: f.topic, title, message, priority, tags });
// Les topics sont partagés entre tous les abonnés (fuseaux différents) :
// dans les notifs on donne une durée relative, jamais une heure.
const inMin = (ms, now) => {
  const m = Math.max(0, Math.round((ms - now) / 60000));
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60), r = Math.round((m % 60) / 5) * 5;
  return `~${h}h${r ? String(r).padStart(2, "0") : ""}`;
};
// Priorités ntfy : 2 = silencieux (pas de son ni vibration), 3 = normal, 5 = urgent (réveil)
const SILENT = 2;

/**
 * Calcule les notifications à envoyer pour un événement.
 * Approche "par niveau" (on regarde l'état actuel, pas les transitions) + mémoire
 * de ce qui a déjà été envoyé => robuste aux crons ratés et à un déploiement en cours de soirée.
 *
 * state = { sent: {clé:1}, nag: {topic: {n, title, message}}, known: {fightId: label} }
 */
export function step(prevState, event, now = Date.now()) {
  const state = structuredClone(prevState || { sent: {}, nag: {}, known: {} });
  const notes = [];
  const send = (key, n) => {
    if (state.sent[key]) return false;
    state.sent[key] = 1;
    notes.push(n);
    return true;
  };

  // 1) relances du réveil (2e, 3e notif urgente, une par minute)
  for (const [topic, g] of Object.entries(state.nag)) {
    if (g.n >= NAG_MAX) continue;
    g.n++;
    notes.push({ topic, title: g.title, message: `${g.message} (${g.n}/${NAG_MAX})`, priority: 5, tags: ["rotating_light", "boxing_glove"] });
  }

  withEstimates(event, now);
  const ids = new Set(event.fights.map((f) => f.id));

  // 2) combats retirés de la carte
  for (const [id, lbl] of Object.entries(state.known)) {
    if (!ids.has(id)) {
      send(`gone:${id}`, { topic: topicFor(id), title: "Combat retiré de la carte", message: `${lbl} n'apparaît plus sur la carte ESPN.`, priority: SILENT, tags: ["warning"] });
      delete state.known[id];
    }
  }
  for (const f of event.fights) state.known[f.id] = label(f);

  // 3) combats annulés
  for (const f of event.fights)
    if (isCancelled(f)) send(`cancel:${f.id}`, note(f, "Combat annulé", `${label(f)} : ${f.detail || "annulé"}`, SILENT, ["warning"]));

  const active = event.fights.filter((f) => !isCancelled(f));
  const evStarted = active.some((f) => f.state !== "pre");

  // 4) "la soirée a commencé" → confirmation pour tous les abonnés
  if (evStarted && !state.sent.started) {
    state.sent.started = 1;
    for (const f of active)
      if (f.state === "pre")
        notes.push(note(f, "La soirée UFC a commencé ✅", `Je surveille pour toi : ${label(f)}. Début estimé dans ${inMin(f.est, now)}. Dors tranquille.`, SILENT, ["white_check_mark"]));
  }

  active.forEach((f, i) => {
    const prev = active[i - 1];
    const prev2 = active[i - 2];
    const lbl = label(f);

    if (f.state === "in") {
      // le combat a démarré
      const woke = state.sent[`go:${f.id}`];
      send(`live:${f.id}`, note(f, "🥊 C'EST PARTI !", `${lbl} a commencé !`, woke ? 3 : 5, ["boxing_glove"]));
      state.sent[`go:${f.id}`] = 1;
      delete state.nag[f.topic];
      return;
    }
    if (f.state !== "pre") return;

    // le combat d'avant est terminé (ou c'est le 1er combat et la soirée démarre) → RÉVEIL
    if (prev && prev.state === "post") {
      const title = "🚨 RÉVEILLE-TOI ! Ton combat arrive";
      const message = `${label(prev)} est terminé. Prochain : ${lbl} (walkouts dans ~10 min)`;
      if (send(`go:${f.id}`, note(f, title, message, 5, ["rotating_light", "boxing_glove"])))
        state.nag[f.topic] = { n: 1, title, message };
      return;
    }

    // pré-alerte : plus qu'un combat avant le tien
    if (prev2 && prev2.state === "post" && prev && prev.state === "in")
      send(`soon:${f.id}`, note(f, "⏰ Plus qu'un combat avant le tien", `${label(prev)} est en cours. Ensuite : ${lbl}. Le réveil sonnera à la fin de ce combat.`, SILENT, ["alarm_clock"]));
  });

  // ménage des relances terminées
  for (const [t, g] of Object.entries(state.nag)) if (g.n >= NAG_MAX) delete state.nag[t];

  return { state, notes };
}
