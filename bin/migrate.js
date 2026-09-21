#!/usr/bin/env node
"use strict";
/* bin/migrate.js -- run the migrations against DATABASE_URL and exit.
 *
 * Exists because of a real near-miss. Proof migrates at BOOT, so production
 * gets its schema the moment a new build starts. The development database
 * only gets it when the app is next started in the workspace -- and if you
 * pull, then Republish without ever running it, Replit's publish pipeline
 * diffs dev against prod, reads the columns prod has and dev doesn't as
 * drift, and offers to DROP them. It offered to drop `category` off 531
 * products.
 *
 * So: after any pull that adds a migration, run `npm run migrate` before
 * republishing. It is the whole fix -- an empty diff proposes nothing.
 *
 * Prints what it applied and exits non-zero if anything failed, so it is
 * safe to chain after a pull.
 */
const DB = require("../lib/db");
const AUTH = require("../lib/auth").create(DB.getPool);
const SCHEMA = require("../proof/schema");

const BRANCHES = {
  odessa: { label: "Odessa" }, louisville: { label: "Louisville" }, byhalia: { label: "Byhalia" },
  wichitafalls: { label: "Wichita Falls" }, lubbock: { label: "Lubbock" }, sanangelo: { label: "San Angelo" }, owensboro: { label: "Owensboro" },
};

// The same list server.js registers, in the same order. Kept here rather than
// imported so this script cannot start a web server as a side effect.
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

(async () => {
  const url = String(process.env.DATABASE_URL || "");
  if (!url) { console.error("DATABASE_URL is not set."); process.exit(1); }
  // Never print the credential; the host is enough to know which database.
  let host = "(unparseable)";
  try { host = new URL(url).host; } catch (e) {}
  console.log("migrating: " + host);
  const r = await DB.migrate();
  console.log(r.applied.length ? "applied: " + r.applied.join(", ") : "nothing to apply -- already up to date");
  console.log(r.total + " migrations registered");
  await DB.getPool().end();
})().catch((e) => { console.error("MIGRATION FAILED:", e && e.message); process.exit(1); });
