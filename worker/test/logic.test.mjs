import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvent, step } from "../src/logic.js";

// Mini carte : 4 combats, le dernier = main event
function card(states) {
  const names = [["A1", "A2"], ["B1", "B2"], ["C1", "C2"], ["Gane", "Hokit"]];
  return parseEvent({
    id: "1", name: "UFC Test", date: "2026-11-14T22:00Z",
    competitions: states.map((s, i) => ({
      id: String(100 + i), date: i < 2 ? "2026-11-14T22:00Z" : "2026-11-15T02:00Z",
      type: { abbreviation: "HW" },
      status: { period: s === "in" ? 2 : 0, displayClock: "3:00",
        type: { state: s === "x" ? "pre" : s, name: s === "x" ? "STATUS_CANCELED" : "", detail: "" } },
      competitors: names[i].map((n, k) => ({ order: k + 1, athlete: { displayName: n } })),
    })),
  });
}
const now = Date.parse("2026-11-15T01:00Z");
const titles = (r) => r.notes.map((n) => `${n.topic}|p${n.priority}|${n.title}`);

test("scénario complet d'une soirée", () => {
  let s = null, r;
  r = step(s, card(["pre", "pre", "pre", "pre"]), now); s = r.state;
  assert.equal(r.notes.length, 0, "rien avant le début");

  r = step(s, card(["in", "pre", "pre", "pre"]), now); s = r.state;
  const t = titles(r);
  assert.ok(t.some((x) => x.startsWith("ufc-reveil-100|p5|🥊")), "1er combat live → urgent");
  assert.equal(t.filter((x) => x.includes("soirée")).length, 3, "confirmation aux 3 autres");

  r = step(s, card(["post", "in", "pre", "pre"]), now); s = r.state;
  assert.ok(titles(r).includes("ufc-reveil-101|p5|🥊 C'EST PARTI !"), "B live sans réveil préalable → urgent");
  assert.ok(titles(r).some((x) => x.startsWith("ufc-reveil-102|p2|⏰")), "pré-alerte pour C");

  r = step(s, card(["post", "post", "pre", "pre"]), now); s = r.state;
  assert.ok(titles(r).some((x) => x.startsWith("ufc-reveil-102|p5|🚨")), "réveil pour C");

  r = step(s, card(["post", "post", "pre", "pre"]), now); s = r.state;
  assert.deepEqual(titles(r), ["ufc-reveil-102|p5|🚨 RÉVEILLE-TOI ! Ton combat arrive"], "relance 2/3");
  r = step(s, card(["post", "post", "in", "pre"]), now); s = r.state;
  assert.ok(titles(r).includes("ufc-reveil-102|p5|🚨 RÉVEILLE-TOI ! Ton combat arrive"), "relance 3/3");
  assert.ok(titles(r).includes("ufc-reveil-102|p3|🥊 C'EST PARTI !"), "live en p3 car déjà réveillé");
  assert.ok(titles(r).some((x) => x.startsWith("ufc-reveil-103|p2|⏰")), "pré-alerte main event");

  r = step(s, card(["post", "post", "in", "pre"]), now); s = r.state;
  assert.equal(r.notes.length, 0, "plus de relance après 3");

  r = step(s, card(["post", "post", "post", "pre"]), now); s = r.state;
  assert.deepEqual(titles(r).map((x) => x.split("|").slice(0, 2).join("|")), ["ufc-reveil-103|p5"], "réveil main event");
});

test("déploiement en pleine soirée : pas de spam, juste le prochain", () => {
  const r = step(null, card(["post", "post", "pre", "pre"]), now);
  const t = titles(r);
  assert.ok(t.some((x) => x.startsWith("ufc-reveil-102|p5|🚨")));
  assert.ok(!t.some((x) => x.startsWith("ufc-reveil-100") || x.startsWith("ufc-reveil-101")));
});

test("combat annulé sauté : le suivant est réveillé", () => {
  const r = step(null, card(["post", "post", "x", "pre"]), now);
  const t = titles(r);
  assert.ok(t.some((x) => x.startsWith("ufc-reveil-102|p2|Combat annulé")));
  assert.ok(t.some((x) => x.startsWith("ufc-reveil-103|p5|🚨")));
});

test("combat retiré de la carte", () => {
  const { state } = step(null, card(["pre", "pre", "pre", "pre"]), now);
  const ev = card(["pre", "pre", "pre", "pre"]);
  ev.fights.splice(1, 1);
  const r = step(state, ev, now);
  assert.ok(titles(r).some((x) => x.startsWith("ufc-reveil-101|p2|Combat retiré")));
});
