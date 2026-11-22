# UFC Fight Alarm - Wake Up Right Before Your Fight

> **Live site:** https://ufc-reveil.ufc-reveil.workers.dev (English and French)

## 📖 Project Context

UFC events in Las Vegas start in the middle of the night in Europe, and the fight you actually care about can begin anywhere between 2 a.m. and 6 a.m. depending on how fast the card goes. A fixed alarm either wakes you up too early or makes you miss the walkouts.

UFC Fight Alarm is a personal project built in November 2026. It follows the fight card live and rings **as soon as the fight right before yours ends**, about 10 minutes before the walkouts.

- **On the phone:** open the site, pick your fight, tap "Wake me up", plug the phone in and go to sleep. The screen turns into a black night clock.
- **When it's time:** a looping alarm plays, the screen flashes and the phone vibrates until you press STOP.
- **On a computer:** a zero-dependency Python CLI does the same from a terminal, with optional push notifications.

## ✨ Implemented Features

- **Live fight card:** upcoming and ongoing UFC events (next 45 days) from ESPN's public scoreboard API, with round and clock of the fight in progress.
- **Start time estimates:** an estimated start time for each fight, recomputed live from the state of the card.
- **In-page alarm:** the alarm sound is generated in the browser as a WAV file and played through an `<audio>` element, so it rings **even in silent mode and Do Not Disturb** on iPhone.
- **Keep the screen awake:** Screen Wake Lock API on Android/Chrome, plus a step-by-step bedtime guide for iPhone and Samsung settings (auto-lock, battery saver, volume).
- **Edge cases handled:** cancelled fights are skipped (the next fight inherits the alarm), fights removed from the card are reported, and the armed alarm survives a page reload.
- **Search:** filter the card by fighter name.
- **English and French:** the language follows the browser, can be switched with one tap (remembered on the device) or forced with `?lang=en` / `?lang=fr`.
- **Python CLI (`ufc_reveil.py`):** interactive fighter selection, local looping alarm on Windows/macOS/Linux, and optional urgent notifications to the phone through [ntfy.sh](https://ntfy.sh).

## 🏗️ Technical Architecture

**Backend - Cloudflare Workers (`worker/src/index.js`)**

1. **API endpoint:** `/api/events` fetches the ESPN scoreboard, parses it and adds estimated start times. Responses are cached at the edge for 30 seconds.
2. **Static hosting:** the web page is served from Workers static assets (`worker/public`).
3. **Optional cron:** a scheduled handler can push notifications through ntfy, with a KV namespace remembering what was already sent. It is disabled since the alarm moved into the page, but kept for future push notifications.

**Shared logic (`worker/src/logic.js`)**

- Pure functions with no network access: ESPN parsing, start time estimation, and the notification decision engine.
- The same module runs on the server and in the browser (copied to `public/logic.js` at build time), so both always apply the same rules.

**Frontend - Vanilla HTML/CSS/JavaScript (`worker/public/index.html`)**

- A single page with no framework and no build step: fight list, bedtime guide, night mode, alarm.
- A small built-in translation dictionary (FR/EN) drives every static and dynamic text, including localized dates.
- It polls the card every 60 seconds, or every 30 seconds once the alarm is armed.

**Tests**

- Node.js built-in test runner (`node --test`) with scenario tests for the alert logic.

## 🧠 Technical Challenges Solved

- **Unpredictable fight times:** fight durations vary from 30 seconds to 25 minutes, so the alarm is not based on a clock. It reacts to the **state** of the card ("previous fight is over"). Estimates are only for display: before the event they are derived from each segment's start time (prelims, main card), during the event from the position of the fight in progress.
- **Phones in silent mode:** a Web Audio beep is muted by the iPhone silent switch. Generating a WAV in memory and playing it as media bypasses it. The audio is unlocked during the user's tap, as mobile browsers require.
- **ESPN blocking Cloudflare IPs:** ESPN sometimes answers `403` to requests coming from Cloudflare. The browser calls ESPN directly first, then falls back to the Worker, which rotates between two ESPN hosts with retries.
- **Robust notifications:** the decision engine compares the current state of the card with a memory of what was already sent, not with state transitions. A missed cron run or a deployment in the middle of an event therefore never spams users or skips an alarm.

## 🎯 How to test the project?

**Online:** open https://ufc-reveil.ufc-reveil.workers.dev on your phone, pick a fight and use "Test the sound" to hear the alarm.

**Locally (Node.js 18+):**

```bash
cd worker
npm install
npm test        # alert logic tests
npm run dev     # local site on http://localhost:8787
```

**Python CLI (Python 3.8+, no dependency):**

```bash
python3 ufc_reveil.py                      # interactive mode
python3 ufc_reveil.py --combattant gane    # pick a fighter directly
python3 ufc_reveil.py --test               # test the alarm right away
```

**Deploy your own copy:** create a KV namespace with `npx wrangler kv namespace create STATE`, put its id in `worker/wrangler.toml`, then run `npx wrangler deploy`.

A French user guide is available in [README.fr.md](README.fr.md).
