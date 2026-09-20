# Proof

Proof of visit for field merchandisers. A merchandiser opens the day's stores, presses **Start
Visit** (location noted), checks each planned item off, photographs each aisle, presses **End
Visit** — and earns points. An admin builds the weekly schedule by dragging teams and people onto
blocks, keeps the store list and product plans, approves new phones, and watches visits live.

Fully standalone: its own server, its own database, its own deploy. It shares nothing at runtime
with The Standard.

## Layout

```
server.js            the one Express process: API, static client, cron, startup migration
lib/db.js            Postgres pool + the migration runner (runs at boot, once per migration)
lib/auth.js          sessions (proof_sessions) and PINs (scrypt, timing-safe)
proof/index.js       the whole domain -- identity, schedule, catalog, visits, points
proof/schema.js      DDL for the proof_* tables
proof/roles.js       the two session roles + the branch gate
public/app.jsx       sign-in, session, error boundary, mount
public/proof-ui.jsx  every screen (merchandiser phone flow + admin desktop)
public/index.html    the page; bundle.js is built, not committed
build.js             esbuild: public/app.jsx -> public/bundle.js
make-proof-icons.py  regenerates the icons (placeholder mark; see the header)
```

## Run locally

```bash
npm install
DATABASE_URL=postgres://... npm run dev      # builds, migrates at boot, serves on :3000
npm test                                     # pure-function tests, no DB
```

The first boot against an empty database creates every table and seeds **Proof Admin / PIN 2468**.
Sign in, go to **Team → Reset PIN**, and change it.

## Deploy (Replit)

1. Import this repo into a new Repl. Add a Postgres database (Replit's own or a Neon URL) — the
   app reads `DATABASE_URL`.
2. Deploy as **Autoscale**. `.replit` carries the build (`npm install && npm run build`) and run
   (`node server.js`) commands. Point a domain (e.g. `proof.standardsales.app`) at it.
3. Open it. Migrations run at startup and log `[boot] database ready`. `GET /api/health` reports
   `ready: true` and the build marker.

Every redeploy re-runs the migration list; anything already applied is skipped. Add a migration
by appending to the `DB.register(...)` list in `server.js` — never edit an applied one.

## Rules that are not obvious from the code

- **One open visit at a time**, enforced by a partial unique index, not just the app.
- **No timer is ever stored.** Timestamps only; a forgotten visit is closed from the last recorded
  event, never from the clock at the next store.
- **Section timing is invisible to the merchandiser.** It fires from their first tap in a section.
- **Location is stamp-and-flag, never block.** Denied permission is a recorded outcome.
- **The first phone binds itself; a second phone waits for admin approval.** That is the
  anti-PIN-sharing control.
- **Points are awarded rows**, never a recomputed total, so a rule change cannot rewrite history.
- Proof is gated to Odessa in `proof/roles.js` (`PROOF_BRANCHES`). Widening it is one line.

## Not built yet

Nightly OneDrive photo archive (columns reserved on `proof_photos`), push notifications, SMS sign-in.
