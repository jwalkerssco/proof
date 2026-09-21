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
2a. **NEVER approve a publish-time migration that contains `DROP` or `ALTER`. Cancel it.**
   Replit's publish pipeline diffs the *development* database against *production* and offers SQL
   to make prod match dev. Because Proof migrates at boot, production gets a new column the moment
   a new build starts, while dev only gets it when the app is next run in the workspace — so the
   pipeline reads correct behaviour as drift and proposes deleting it. Observed 2026-09-21, one
   click from dropping `category` off 531 products and undoing the beer/NA feature.
   **The fix is to keep dev in step, so the diff is empty by construction:**
   ```bash
   npm run migrate      # after any pull that adds a migration, BEFORE republishing
   ```
   Cancelling a publish costs a minute. Approving one costs data.
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
npm run migrate     # brings the DEV database in step -- skip it and the publish step offers to DROP
```
…then Republish. `npm run migrate` prints the database host it touched and what it applied; it
never prints the credential.

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
