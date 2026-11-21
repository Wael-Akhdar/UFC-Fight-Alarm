#!/usr/bin/env python3
"""
UFC Réveil — te réveille quand TON combat UFC va commencer.

- Lit les données live d'ESPN (API publique, pas de clé).
- Vérifie toutes les 60 s l'état de la carte.
- Dès que le combat juste avant est terminé (ou que ton combat démarre),
  envoie une notification URGENTE sur ton téléphone via ntfy.sh
  et joue une alarme en boucle sur le PC.

Aucune dépendance : Python 3.8+ suffit.

Exemples :
    python3 ufc_reveil.py                       # mode interactif
    python3 ufc_reveil.py --combattant gane --topic mon-topic-secret
    python3 ufc_reveil.py --test --topic mon-topic-secret
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import platform
import secrets
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.request
import wave

ESPN = "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard"
NTFY = "https://ntfy.sh"
UA = {"User-Agent": "ufc-reveil/1.0"}


# --------------------------------------------------------------------------- #
#  ESPN
# --------------------------------------------------------------------------- #
def http_json(url: str, data: dict | None = None, timeout: int = 15) -> dict:
    body = json.dumps(data).encode() if data is not None else None
    headers = dict(UA)
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def fetch_events(days: int = 45) -> list[dict]:
    """Événements UFC d'aujourd'hui (UTC-1 jour, pour les soirées en cours) à +days."""
    start = dt.datetime.utcnow() - dt.timedelta(days=1)
    end = start + dt.timedelta(days=days)
    d = http_json(f"{ESPN}?dates={start:%Y%m%d}-{end:%Y%m%d}")
    return [parse_event(e) for e in d.get("events", [])]


def fetch_event(event_id: str, date_iso: str) -> dict:
    day = dt.datetime.fromisoformat(date_iso.replace("Z", "+00:00"))
    a = (day - dt.timedelta(days=1)).strftime("%Y%m%d")
    b = (day + dt.timedelta(days=1)).strftime("%Y%m%d")
    d = http_json(f"{ESPN}?dates={a}-{b}")
    for e in d.get("events", []):
        if e["id"] == event_id:
            return parse_event(e)
    raise RuntimeError("Événement introuvable chez ESPN")


def parse_event(e: dict) -> dict:
    fights = []
    for c in e.get("competitions", []):
        st = c.get("status", {})
        typ = st.get("type", {})
        comps = sorted(c.get("competitors", []), key=lambda x: x.get("order", 0))
        fights.append({
            "id": c["id"],
            "date": c.get("date"),
            "categorie": (c.get("type") or {}).get("abbreviation", ""),
            "noms": [x.get("athlete", {}).get("displayName", "?") for x in comps],
            "state": typ.get("state", "pre"),          # pre | in | post
            "status": typ.get("name", ""),             # STATUS_SCHEDULED, STATUS_IN_PROGRESS, STATUS_FINAL, STATUS_CANCELED...
            "detail": typ.get("detail", ""),
            "round": st.get("period", 0),
            "clock": st.get("displayClock", ""),
        })
    return {"id": e["id"], "nom": e.get("name", ""), "date": e.get("date"), "fights": fights}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return s.lower()


def label(f: dict) -> str:
    return " vs ".join(f["noms"])


def local_time(iso: str | None) -> str:
    if not iso:
        return "?"
    t = dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
    return t.strftime("%a %d/%m %H:%M")


# --------------------------------------------------------------------------- #
#  Notifications : ntfy + alarme locale
# --------------------------------------------------------------------------- #
def ntfy(topic: str, title: str, message: str, priority: int = 5, tags=("rotating_light",)) -> None:
    if not topic:
        return
    try:
        http_json(NTFY, {"topic": topic, "title": title, "message": message,
                         "priority": priority, "tags": list(tags)})
    except Exception as exc:  # on ne plante jamais pour une notif
        print(f"  ⚠️  ntfy a échoué : {exc}")


def _make_wav() -> str:
    path = os.path.join(tempfile.gettempdir(), "ufc_reveil_alarme.wav")
    if os.path.exists(path):
        return path
    rate = 22050
    frames = bytearray()
    for i in range(int(rate * 1.2)):
        t = i / rate
        on = int(t * 8) % 2 == 0                      # bip-bip-bip
        freq = 880 if int(t * 4) % 2 == 0 else 1320
        v = 0.6 * math.sin(2 * math.pi * freq * t) if on else 0.0
        frames += struct.pack("<h", int(v * 32767))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return path


def _is_wsl() -> bool:
    return "microsoft" in platform.uname().release.lower()


def play_once() -> None:
    wav = _make_wav()
    try:
        if sys.platform == "win32":
            import winsound
            winsound.PlaySound(wav, winsound.SND_FILENAME)
        elif _is_wsl() and shutil.which("powershell.exe"):
            win = subprocess.run(["wslpath", "-w", wav], capture_output=True, text=True).stdout.strip()
            subprocess.run(["powershell.exe", "-NoProfile", "-c",
                            f"(New-Object Media.SoundPlayer '{win}').PlaySync()"],
                           capture_output=True, timeout=10)
        elif sys.platform == "darwin":
            subprocess.run(["afplay", wav], timeout=10)
        elif shutil.which("paplay"):
            subprocess.run(["paplay", wav], timeout=10)
        elif shutil.which("aplay"):
            subprocess.run(["aplay", "-q", wav], timeout=10)
        else:
            print("\a", end="", flush=True)
            time.sleep(1)
    except Exception:
        print("\a", end="", flush=True)
        time.sleep(1)


def alarm_loop(stop: threading.Event) -> None:
    while not stop.is_set():
        play_once()
        time.sleep(0.3)


def ring(topic: str, title: str, message: str, repeats: int, no_sound: bool) -> None:
    """Notif urgente répétée sur le tél + alarme PC jusqu'à Entrée."""
    print("\n" + "=" * 60)
    print(f"🚨  {title}\n    {message}")
    print("=" * 60)
    stop = threading.Event()
    if not no_sound:
        threading.Thread(target=alarm_loop, args=(stop,), daemon=True).start()

    def nag():
        for i in range(max(1, repeats)):
            if stop.is_set():
                return
            ntfy(topic, title, message + (f" ({i + 1}/{repeats})" if repeats > 1 else ""), 5,
                 ("rotating_light", "boxing_glove"))
            stop.wait(45)
    threading.Thread(target=nag, daemon=True).start()

    try:
        input("\n>>> Appuie sur Entrée pour couper l'alarme... ")
    except (EOFError, KeyboardInterrupt):
        pass
    stop.set()


# --------------------------------------------------------------------------- #
#  Logique de surveillance
# --------------------------------------------------------------------------- #
def check(event: dict, fight_id: str, avance: int, sent: set) -> list[tuple[str, str, str, int]]:
    """Retourne les alertes à déclencher : (clé, titre, message, priorité)."""
    fights = event["fights"]
    idx = next((i for i, f in enumerate(fights) if f["id"] == fight_id), None)
    if idx is None:
        return [("gone", "Combat retiré de la carte", "Ton combat n'apparaît plus chez ESPN.", 4)]
    me = fights[idx]
    name = label(me)
    out = []

    if me["status"] in ("STATUS_CANCELED", "STATUS_POSTPONED") or "cancel" in me["detail"].lower():
        out.append(("cancel", "Combat annulé ?", f"{name} : {me['detail']}", 4))
        return out

    if me["state"] in ("in", "post"):
        out.append(("go", "🥊 C'EST PARTI !", f"{name} a commencé ({me['detail']})", 5))
        return out

    prev = fights[idx - 1] if idx > 0 else None
    if prev and prev["state"] == "post":
        out.append(("go", "🥊 RÉVEILLE-TOI ! Ton combat arrive",
                    f"{label(prev)} est terminé. Prochain : {name} (walkouts dans ~10 min)", 5))
        return out

    # pré-alerte douce, N combats avant
    if avance > 1 and idx - avance >= 0:
        early = fights[idx - avance]
        if early["state"] == "post":
            out.append((f"early{avance}", "⏰ Ça se rapproche",
                        f"Plus que {avance - 1} combat(s) avant {name}", 4))
    return [a for a in out if a[0] not in sent]


def describe(event: dict, fight_id: str) -> str:
    fights = event["fights"]
    idx = next((i for i, f in enumerate(fights) if f["id"] == fight_id), 0)
    live = next((f for f in fights if f["state"] == "in"), None)
    done = sum(1 for f in fights[:idx] if f["state"] == "post")
    s = f"{done}/{idx} combats avant le tien terminés"
    if live:
        s += f" · en cours : {label(live)} R{live['round']} {live['clock']}"
    return s


def watch(event: dict, fight_id: str, topic: str, interval: int, avance: int,
          repeats: int, no_sound: bool) -> None:
    me = next(f for f in event["fights"] if f["id"] == fight_id)
    print(f"\n👀 Surveillance de : {label(me)}  ({event['nom']})")
    print(f"   Vérification toutes les {interval} s. Ctrl+C pour arrêter.\n")
    ntfy(topic, "UFC Réveil activé ✅", f"Je te réveille pour {label(me)}", 3, ("white_check_mark",))
    sent: set = set()
    while True:
        try:
            event = fetch_event(event["id"], event["date"])
            alerts = check(event, fight_id, avance, sent)
            now = time.strftime("%H:%M:%S")
            print(f"[{now}] {describe(event, fight_id)}")
            for key, title, msg, prio in alerts:
                sent.add(key)
                if prio >= 5:
                    ring(topic, title, msg, repeats, no_sound)
                    print("\n✅ Bon combat ! Fin de la surveillance.")
                    return
                print(f"   🔔 {title} — {msg}")
                ntfy(topic, title, msg, 2, ("alarm_clock",))  # silencieux : seul le réveil sonne
                if key in ("cancel", "gone"):
                    return
        except KeyboardInterrupt:
            raise
        except Exception as exc:
            print(f"[{time.strftime('%H:%M:%S')}] ⚠️  erreur réseau : {exc} (on réessaie)")
        time.sleep(interval)


# --------------------------------------------------------------------------- #
#  Interface
# --------------------------------------------------------------------------- #
def choose(prompt: str, n: int) -> int:
    while True:
        r = input(prompt).strip()
        if r.isdigit() and 1 <= int(r) <= n:
            return int(r) - 1
        print("  Numéro invalide.")


def pick_fight(events: list[dict], query: str | None) -> tuple[dict, dict]:
    if query:
        q = norm(query)
        hits = [(e, f) for e in events for f in e["fights"] if q in norm(" ".join(f["noms"]))]
        if not hits:
            sys.exit(f"Aucun combat trouvé pour « {query} ».")
        if len(hits) == 1:
            return hits[0]
        for i, (e, f) in enumerate(hits, 1):
            print(f"  {i}. {label(f)} — {e['nom']} ({local_time(e['date'])})")
        return hits[choose("Quel combat ? ", len(hits))]

    for i, e in enumerate(events, 1):
        print(f"  {i}. {e['nom']} — {local_time(e['date'])}")
    ev = events[choose("Quel événement ? ", len(events))]
    print()
    n = len(ev["fights"])
    for i, f in enumerate(ev["fights"], 1):
        tag = " ⭐ MAIN EVENT" if i == n else ""
        print(f"  {i:2}. {label(f):45} {f['categorie']:16} [{f['state']}]{tag}")
    return ev, ev["fights"][choose("Quel combat ? ", n)]


def main() -> None:
    ap = argparse.ArgumentParser(description="Te réveille quand ton combat UFC commence.")
    ap.add_argument("-c", "--combattant", help="nom (ou bout de nom) d'un combattant")
    ap.add_argument("-t", "--topic", default=os.environ.get("NTFY_TOPIC"),
                    help="ton topic ntfy.sh (ou variable NTFY_TOPIC)")
    ap.add_argument("-i", "--intervalle", type=int, default=60, help="secondes entre 2 vérifs (défaut 60)")
    ap.add_argument("-a", "--avance", type=int, default=3,
                    help="pré-alerte douce quand il reste N-1 combats (défaut 3, 0 = off)")
    ap.add_argument("-r", "--repetitions", type=int, default=5,
                    help="nb de notifs urgentes envoyées (toutes les 45 s) tant que tu ne coupes pas")
    ap.add_argument("--sans-son", action="store_true", help="pas d'alarme sur le PC")
    ap.add_argument("--test", action="store_true", help="teste la notif + l'alarme puis quitte")
    a = ap.parse_args()

    print("🥊 UFC Réveil\n")
    topic = a.topic
    if not topic:
        sugg = "ufc-reveil-" + secrets.token_hex(4)
        topic = input(f"Topic ntfy (Entrée pour « {sugg} ») : ").strip() or sugg
        print(f"\n📱 Sur ton tél : app ntfy → « + » → abonne-toi à : {topic}")
        print(f"   (ou ouvre {NTFY}/{topic})\n")

    if a.test:
        ring(topic, "🧪 Test UFC Réveil", "Si tu lis ça, tout marche !", 1, a.sans_son)
        return

    print("Chargement de la carte ESPN...")
    events = [e for e in fetch_events() if e["fights"]]
    if not events:
        sys.exit("Aucun événement UFC à venir trouvé.")
    ev, fight = pick_fight(events, a.combattant)
    try:
        watch(ev, fight["id"], topic, max(20, a.intervalle), a.avance, a.repetitions, a.sans_son)
    except KeyboardInterrupt:
        print("\nArrêté.")


if __name__ == "__main__":
    main()
