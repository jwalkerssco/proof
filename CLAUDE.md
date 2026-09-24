# Proof — working conventions

Standalone merchandiser app for Standard Sales Company. Owner/developer: Jess Walker. Shares
**nothing at runtime** with The Standard (`jwalkerssco/the-standard`) — not the server, not the
database, not the sessions. Read `README.md` first; it carries the layout and the deploy runbook.

## Hard rules

1. **One server, one bundle, one tree.** `server.js` is the only server file; `public/app.jsx` →
   `public/bundle.js` is the only bundle. Do not add a second of either. (The Standard's history
   shows exactly how a stale duplicate costs deploy cycles.)
2. **Migrations run at startup, in `DB.register` order, once each.** Append a new one; never edit
   an applied one — write a new entry that alters. `CREATE ... IF NOT EXISTS` everywhere so a
   re-run is a no-op.
2a. **At the publish step, READ the proposed SQL and let its DIRECTION decide. Never approve a
   `DROP` or a destructive `ALTER`.**
   Replit's publish pipeline diffs the *development* database against *production* and offers SQL
   to make prod match dev. **Both databases carry the same migrations but never at the same
   moment** — dev gets one when the app next runs in the workspace, prod gets it when the new
   build boots — so on any deploy that adds a migration the diff is non-empty by construction.
   Which way it points is the whole answer:

   | Proposed SQL | What it means | Do |
   |---|---|---|
   | `ADD COLUMN` / `CREATE INDEX` / `CREATE TABLE` | **dev ahead** — prod has not booted the new build | **Approve.** It is the boot migration a minute early. Every statement in `schema.js` is `IF NOT EXISTS`, so the boot run still succeeds and records itself. |
   | `DROP` / `DELETE` / destructive `ALTER` | **prod ahead** — prod booted the new code, dev never ran it, and the pipeline is reading prod's correct columns as drift | **Cancel.** Run `npm run migrate`, then republish. |

   Observed 2026-09-21 in the dangerous direction: one click from dropping `category` off 531
   products and undoing the beer/NA feature. Observed 2026-09-24 in the safe one: `ADD COLUMN
   brand` / `aisle` on `proof_photos`, approved, no incident.
   **CORRECTED 2026-09-24 — the earlier text here said to run `npm run migrate` BEFORE republishing
   so "the diff is empty by construction". There is no such ordering.** Running it first only makes
   dev the ahead one, which is the safe branch but not an empty diff. The real use of that script is
   **after** a deploy, to bring dev up to what prod already booted — that is what stops the *next*
   publish proposing a drop.
   Cancelling a publish costs a minute. Approving the wrong one costs data.
3. **Proof reads and writes only `proof_*` tables** (plus `branches` and `schema_migrations`).
   Keep it that way; it is what keeps the app portable.
4. **No timer is ever stored.** Timestamps in, durations derived on read. A forgotten visit
   closes from its last event, never from `now()`.
5. **Section timing is invisible to the merchandiser.** It fires from their first tap in a
   section. Never add a button for it.
6. **Location is stamp-and-flag, never block.**
7. **One open visit at a time** — the partial unique index on `proof_visits` is the guarantee;
   app code is the courtesy.
8. **Every write reports back** (toast), **every list has an empty state**, **every destructive
   action confirms.** That is the UI contract.
9. **A PIN is never readable.** Reset only.
10. **Photos are base64 text in `proof_photos`.** The OneDrive archive columns are reserved;
    the archive is not built.

## Verify before you push

```bash
npm test          # pure-function tests + SSR of every screen, no DB
npm run build     # public/bundle.js
node --check server.js lib/db.js lib/auth.js proof/index.js proof/schema.js
```

Deploying a pull, in order:

```bash
git fetch origin main && git merge --no-edit FETCH_HEAD
npm install && npm run build
```
…then Republish, and read the publish step's proposed SQL per rule 2a — on a deploy that adds a
migration it will propose something, and the direction says whether to approve.

**After** the deploy has promoted:

```bash
npm run migrate     # brings DEV up to what prod just booted
```
That is the ordering that matters: it leaves the two in step, so the NEXT publish — the one that
adds no migration — proposes nothing. `npm run migrate` prints the database host it touched and
what it applied; it never prints the credential.

Bump `MARKER` in `server.js` with any change; `GET /api/health` reports it, so "is the new build
live" is one request.

## Where things are

| Need | Where |
|---|---|
| A new table or column | `proof/schema.js` + a `DB.register` line in `server.js` |
| A new endpoint | `server.js`, behind `requireRole("proof","proofadmin")` or `("proofadmin")` |
| Domain logic | `proof/index.js` (`create(deps)`, never requires `server.js`) |
| A screen | `public/proof-ui.jsx`; primitives (`Card`, `Btn`, `Badge`, `Sheet`, `Toast`) at the top |
| Sign-in / session | `public/app.jsx` (client), `lib/auth.js` (server) |
| Branch gate | `proof/roles.js` `PROOF_BRANCHES` |
| Icons | `make-proof-icons.py` — placeholder mark until real vector art exists |
