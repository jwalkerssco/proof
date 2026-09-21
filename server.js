"use strict";
/* server.js -- Proof. One Express process: the API, the static client, the
 * nightly cron, and the startup migration. There is exactly one server file
 * in this repo, on purpose.
 *
 * Boot order matters for a Cloud Run-style healthcheck: app.listen() fires
 * immediately; the database migration runs in the background and every DB
 * route answers 503 until it has finished.
 */
const path = require("path");
const fs = require("fs");
const express = require("express");
const cron = require("node-cron");

const multer = require("multer");
const DB = require("./lib/db");
const AUTH = require("./lib/auth").create(DB.getPool);
const SHEET = require("./lib/sheet");
const SCHEMA = require("./proof/schema");
const PROOF_MOD = require("./proof");

// 15 MB covers any realistic store or product export; held in memory, never
// written to disk -- the rows go straight into Postgres and the buffer dies.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/* ---- branches: a small code registry, mirrored into a table for FKs ---- */
const BRANCHES = {
  odessa: { label: "Odessa" }, louisville: { label: "Louisville" }, byhalia: { label: "Byhalia" },
  wichitafalls: { label: "Wichita Falls" }, lubbock: { label: "Lubbock" }, sanangelo: { label: "San Angelo" }, owensboro: { label: "Owensboro" },
};

/* ---- migrations, in order ---- */
DB.register("001_base", async (pool) => {
  await pool.query("CREATE TABLE IF NOT EXISTS branches (id text PRIMARY KEY, label text NOT NULL)");
  for (const id of Object.keys(BRANCHES)) {
    await pool.query("INSERT INTO branches (id, label) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label", [id, BRANCHES[id].label]);
  }
  const s = await AUTH.migrateSessions(pool);
  return { tables: ["branches", s.table], branches: Object.keys(BRANCHES).length };
});
DB.register("002_identity", (pool) => SCHEMA.migrateIdentity(pool, AUTH.hashPin));
DB.register("003_ops", (pool) => SCHEMA.migrateOps(pool));
DB.register("004_catalog", (pool) => SCHEMA.migrateCatalog(pool));
DB.register("005_visits", (pool) => SCHEMA.migrateVisits(pool));
DB.register("006_points", (pool) => SCHEMA.migratePoints(pool));
DB.register("007_categories", (pool) => SCHEMA.migrateCategories(pool));

const PROOF = PROOF_MOD.create({
  getPool: DB.getPool, BRANCHES, SESSION_MS: AUTH.SESSION_MS,
  hashPin: AUTH.hashPin, verifyPin: AUTH.verifyPin, makeToken: AUTH.makeToken,
  _sessionEstablish: AUTH._sessionEstablish, revokeSessionsFor: AUTH.revokeSessionsFor,
  batchUpsert: DB.batchUpsert,
});

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "15mb" })); // a compressed photo is ~150-400 KB as a data URL

let ready = false, bootError = null;
app.use("/api", (req, res, next) => {
  if (ready) return next();
  if (req.path === "/health") return next();
  return res.status(503).json({ error: bootError ? "database setup failed" : "starting up", pending: true });
});

const requireRole = AUTH.requireRole;
const wrap = (fn) => async (req, res) => {
  try { const out = await fn(req); if (out && out.error) return res.status(out.pending ? 200 : 400).json(out); res.json(out); }
  catch (e) { console.error("[proof]", req.method, req.path, e && e.message); res.status(503).json({ error: "unavailable" }); }
};
const MARKER = "proof-0.4.0";

app.get("/api/health", (req, res) => res.json({ ok: true, ready, marker: MARKER, node: process.version, at: new Date().toISOString() }));
app.get("/api/migrations", requireRole("proofadmin"), wrap(() => DB.listMigrations()));

/* ---- auth ---- */
app.get("/api/login-options", wrap(() => PROOF.loginOptions()));
app.post("/api/login", wrap((req) => PROOF.login((req.body || {}).id, (req.body || {}).pin, { deviceId: (req.body || {}).deviceId })));
app.post("/api/logout", async (req, res) => { try { await AUTH.logout(req.get("x-auth-token")); } catch (e) {} res.json({ ok: true }); });
app.get("/api/bootstrap", requireRole("proof", "proofadmin"), wrap((req) => PROOF.bootstrap(req.session)));

/* ---- people + devices (admin) ---- */
app.get("/api/people", requireRole("proofadmin"), wrap((req) => PROOF.people(req.session.branch)));
app.post("/api/people", requireRole("proofadmin"), wrap((req) => PROOF.addPerson({ ...(req.body || {}), branch: req.session.branch })));
app.post("/api/people/:id/pin", requireRole("proofadmin"), wrap((req) => PROOF.setPin(req.params.id, (req.body || {}).pin)));
app.post("/api/people/:id/active", requireRole("proofadmin"), wrap((req) => PROOF.setActive(req.params.id, !!(req.body || {}).active)));
app.post("/api/people/:id/team", requireRole("proofadmin"), wrap((req) => PROOF.setPersonTeam(req.session.branch, req.params.id, (req.body || {}).teamId)));
app.get("/api/devices/pending", requireRole("proofadmin"), wrap((req) => PROOF.devicesPending(req.session.branch)));
app.post("/api/devices/:merchId/:deviceId/approve", requireRole("proofadmin"), wrap((req) => PROOF.deviceApprove(req.params.merchId, req.params.deviceId, req.session.id)));
app.post("/api/devices/:merchId/:deviceId/revoke", requireRole("proofadmin"), wrap((req) => PROOF.deviceRevoke(req.params.merchId, req.params.deviceId)));
app.get("/api/devices/:merchId", requireRole("proofadmin"), wrap((req) => PROOF.devicesFor(req.params.merchId)));

/* ---- stores ---- */
app.get("/api/stores", requireRole("proof", "proofadmin"), wrap((req) => PROOF.stores(req.session.branch, { route: req.query.route, q: req.query.q, limit: req.query.limit, includeClosed: req.query.includeClosed === "1" })));
app.post("/api/stores/upload", requireRole("proofadmin"), wrap((req) => { const b = req.body || {}; return PROOF.uploadStores(req.session.branch, b.rows, { apply: !!b.apply, closeMissing: !!b.closeMissing, force: !!b.force }); }));
/* File upload: .xlsx / .xls / .csv straight out of a spreadsheet. Same
   preview-then-apply contract as the paste path -- the flags ride as form
   fields because multipart carries no JSON body. */
app.post("/api/stores/upload-file", requireRole("proofadmin"), upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file was attached." });
    const parsed = SHEET.parseWorkbook(req.file.buffer);
    if (parsed.error) return res.status(400).json(parsed);
    const b = req.body || {};
    const out = await PROOF.uploadStores(req.session.branch, parsed.rows, { apply: b.apply === "1", closeMissing: b.closeMissing === "1", force: b.force === "1" });
    res.status(out && out.error && !out.preview ? 400 : 200).json(Object.assign({ file: req.file.originalname, sheet: parsed.sheet, sheets: parsed.sheets, headerRow: parsed.headerRow }, out));
  } catch (e) { console.error("[proof] stores/upload-file", e && e.message); res.status(503).json({ error: "Couldn't read that file." }); }
});
app.get("/api/stores/:id/detail", requireRole("proof", "proofadmin"), wrap((req) => PROOF.storeDetail(req.session.branch, req.params.id, req.query.category)));
app.get("/api/categories", requireRole("proof", "proofadmin"), (req, res) => res.json({ categories: PROOF_MOD.PRODUCT_CATEGORIES }));
app.get("/api/stores/:id/sections", requireRole("proof", "proofadmin"), wrap((req) => PROOF.sections(req.session.branch, req.params.id)));
app.post("/api/stores/:id/sections", requireRole("proofadmin"), wrap((req) => PROOF.sectionSave(req.session.branch, req.params.id, req.body || {})));
app.get("/api/stores/:id/plan", requireRole("proof", "proofadmin"), wrap((req) => PROOF.planItems(req.session.branch, req.params.id, req.query.category)));
app.post("/api/stores/:id/plan", requireRole("proofadmin"), wrap((req) => {
  const b = req.body || {};
  if (b.copyFrom) return PROOF.planItemsCopy(req.session.branch, b.copyFrom, req.params.id);
  if (b.remove) return PROOF.planItemRemove(req.session.branch, b.id);
  return PROOF.planItemSet(req.session.branch, { ...b, storeId: req.params.id });
}));
app.post("/api/sections/:id/remove", requireRole("proofadmin"), wrap((req) => PROOF.sectionRemove(req.session.branch, Number(req.params.id))));

/* ---- schedule: teams, blocks, block stores, block members ---- */
app.get("/api/week", requireRole("proofadmin"), wrap((req) => PROOF.week(req.session.branch)));
app.get("/api/teams", requireRole("proof", "proofadmin"), wrap((req) => PROOF.teams(req.session.branch)));
app.post("/api/teams", requireRole("proofadmin"), wrap((req) => PROOF.teamSave(req.session.branch, req.body || {})));
app.post("/api/teams/:id/remove", requireRole("proofadmin"), wrap((req) => PROOF.teamRemove(req.session.branch, req.params.id)));
app.post("/api/blocks", requireRole("proofadmin"), wrap((req) => PROOF.blockAdd(req.session.branch, req.body || {})));
app.post("/api/blocks/:id", requireRole("proofadmin"), wrap((req) => PROOF.blockUpdate(req.session.branch, Number(req.params.id), req.body || {})));
app.post("/api/blocks/:id/remove", requireRole("proofadmin"), wrap((req) => PROOF.blockRemove(req.session.branch, Number(req.params.id))));
app.post("/api/blocks/:id/stores", requireRole("proofadmin"), wrap((req) => {
  const b = req.body || {}, blockId = Number(req.params.id);
  if (b.remove) return PROOF.blockStoreRemove(blockId, b.storeId, b.rowId);
  if (b.flagsOnly) return PROOF.blockStoreFlags(b.rowId, b.flags);
  return PROOF.blockStoreAdd(blockId, b.storeId, b.flags);
}));
app.post("/api/blocks/:id/members", requireRole("proofadmin"), wrap((req) => {
  const b = req.body || {}, blockId = Number(req.params.id);
  return b.remove ? PROOF.blockMemberRemove(blockId, b.personId) : PROOF.blockMemberAdd(blockId, b.personId, req.session.id);
}));

/* ---- catalog ---- */
app.get("/api/products", requireRole("proof", "proofadmin"), wrap((req) => PROOF.products(req.session.branch, { q: req.query.q, limit: req.query.limit, category: req.query.category })));
app.post("/api/products/category", requireRole("proofadmin"), wrap((req) => { const b = req.body || {}; return PROOF.productsSetCategory(req.session.branch, b.ids, b.category); }));
app.post("/api/products", requireRole("proofadmin"), wrap((req) => { const b = req.body || {}; return b.rows ? PROOF.productsUpload(req.session.branch, b.rows, { apply: !!b.apply }) : PROOF.productSave(req.session.branch, b); }));
app.post("/api/products/:id/remove", requireRole("proofadmin"), wrap((req) => PROOF.productRemove(req.session.branch, req.params.id)));
app.post("/api/products/upload-file", requireRole("proofadmin"), upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file was attached." });
    const parsed = SHEET.parseWorkbook(req.file.buffer);
    if (parsed.error) return res.status(400).json(parsed);
    const out = await PROOF.productsUpload(req.session.branch, parsed.rows, { apply: (req.body || {}).apply === "1" });
    res.status(out && out.error ? 400 : 200).json(Object.assign({ file: req.file.originalname, sheet: parsed.sheet, sheets: parsed.sheets }, out));
  } catch (e) { console.error("[proof] products/upload-file", e && e.message); res.status(503).json({ error: "Couldn't read that file." }); }
});

/* ---- visits: every write requires an open visit owned by the caller ---- */
app.get("/api/visits/open", requireRole("proof", "proofadmin"), wrap((req) => PROOF.blockedOpenVisit(req.session).then((v) => ({ open: !!v, ...(v || {}) }))));
app.get("/api/visits/mine", requireRole("proof", "proofadmin"), wrap((req) => PROOF.myVisits(req.session, req.query.date)));
app.post("/api/visits/start", requireRole("proof", "proofadmin"), wrap((req) => { const b = req.body || {}; return PROOF.startVisit(req.session, { storeId: b.storeId, blockId: b.blockId, lat: b.lat, lng: b.lng, accuracy: b.accuracy, geoDenied: !!b.geoDenied, deviceId: b.deviceId, atClient: b.atClient, category: b.category }); }));
app.post("/api/visits/:id/section-enter", requireRole("proof", "proofadmin"), wrap((req) => { const sid = (req.body || {}).sectionId; return PROOF.sectionEnter(Number(req.params.id), sid != null ? Number(sid) : null, (req.body || {}).atClient); }));
app.post("/api/visits/:id/section-exit", requireRole("proof", "proofadmin"), wrap((req) => { const sid = (req.body || {}).sectionId; return PROOF.sectionExit(Number(req.params.id), sid != null ? Number(sid) : null, (req.body || {}).atClient); }));
app.post("/api/visits/:id/item-result", requireRole("proof", "proofadmin"), wrap((req) => { const b = req.body || {}; return PROOF.itemResult(Number(req.params.id), b.planItemId, b.status, b.note); }));
app.post("/api/visits/:id/photo", requireRole("proof", "proofadmin"), wrap((req) => { const b = req.body || {}; return PROOF.addPhoto(Number(req.params.id), b.sectionId, b.dataUrl, b.mime); }));
app.post("/api/visits/:id/forgotten", requireRole("proof", "proofadmin"), wrap((req) => PROOF.closeForgotten(Number(req.params.id))));
app.post("/api/visits/:id/end", requireRole("proof", "proofadmin"), wrap((req) => PROOF.endVisit(req.session, Number(req.params.id), (req.body || {}).atClient)));
app.get("/api/visits/:id", requireRole("proof", "proofadmin"), wrap((req) => PROOF.visitDetail(Number(req.params.id))));
/* The image bytes, kept out of the visit JSON so a twenty-photo visit is a
   small payload and the browser fetches each picture lazily. Private -- it is
   behind a session -- but immutable, so a manager scrolling a visit does not
   refetch the same JPEG. */
app.get("/api/photos/:id", requireRole("proof", "proofadmin"), async (req, res) => {
  try {
    const out = await PROOF.photo(req.session, Number(req.params.id));
    if (out.error) return res.status(out.error === "forbidden" ? 403 : 404).json(out);
    res.set("Content-Type", out.mime).set("Cache-Control", "private, max-age=86400").send(out.buffer);
  } catch (e) { console.error("[proof] photo", e && e.message); res.status(503).json({ error: "unavailable" }); }
});

/* ---- admin views, points ---- */
app.get("/api/admin/live", requireRole("proofadmin"), wrap((req) => PROOF.liveCompletion(req.session.branch, req.query.date)));
app.get("/api/admin/reporting", requireRole("proofadmin"), wrap((req) => PROOF.reporting(req.session.branch, { from: req.query.from, to: req.query.to, includeAutoClosed: req.query.includeAutoClosed === "1" })));
app.get("/api/admin/reporting/categories", requireRole("proofadmin"), wrap((req) => PROOF.reportCategories(req.session.branch, { from: req.query.from, to: req.query.to, includeAutoClosed: req.query.includeAutoClosed === "1" })));
app.get("/api/admin/reporting/brands", requireRole("proofadmin"), wrap((req) => PROOF.reportBrands(req.session.branch, { from: req.query.from, to: req.query.to, category: req.query.category, includeAutoClosed: req.query.includeAutoClosed === "1" })));
app.get("/api/leaderboard", requireRole("proof", "proofadmin"), wrap((req) => PROOF.leaderboard(req.session.branch, req.query.period || new Date().toISOString().slice(0, 7))));
app.post("/api/admin/points", requireRole("proofadmin"), wrap((req) => { const b = req.body || {}; return PROOF.awardPoints(req.session.branch, b.merchId, b.periodKey || new Date().toISOString().slice(0, 7), Number(b.points), b.reason, b.visitId); }));

/* ---- static client ---- */
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", setHeaders: (res, fp) => { if (/index\.html$|bundle\.js$/.test(fp)) res.setHeader("Cache-Control", "no-cache"); } }));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || /\.[a-z0-9]{2,5}$/i.test(req.path)) return res.status(404).send("Not found");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---- cron (Central) ---- */
cron.schedule("20 5 * * *", async () => {
  try { const out = await PROOF.nightlySweepOpenVisits(); if (out.closed) console.log("[cron] nightly sweep closed " + out.closed + " open visit(s)"); }
  catch (e) { console.error("[cron] nightly sweep failed:", e && e.message); }
}, { timezone: "America/Chicago" });
cron.schedule("0 5 * * *", async () => {
  try { const n = await AUTH.pruneExpired(); if (n) console.log("[cron] pruned " + n + " expired sessions"); }
  catch (e) { console.error("[cron] session prune failed:", e && e.message); }
}, { timezone: "America/Chicago" });

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Proof " + MARKER + " listening on " + PORT));
DB.migrate()
  .then((r) => { ready = true; console.log("[boot] database ready" + (r.applied.length ? " -- applied " + r.applied.join(", ") : "")); })
  .catch((e) => { bootError = e; console.error("[boot] MIGRATION FAILED -- API answering 503:", e && e.message); });
