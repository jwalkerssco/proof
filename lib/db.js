"use strict";
/* lib/db.js -- the Postgres pool and the migration runner.
 *
 * Migrations run AT STARTUP, in registry order, each once (recorded in
 * schema_migrations). Idempotent DDL throughout, so a restart is a no-op and
 * a dev database and a production database both end up with the same schema
 * from the same code -- there is no separate "apply to prod" step and nothing
 * for a publish pipeline to diff.
 */
const { Pool } = require("pg");

let pool = null;
function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1|helium/.test(url) ? false : { rejectUnauthorized: false }, max: 8 });
  pool.on("error", (e) => console.error("[pg] pool error:", e && e.message));
  return pool;
}

const MIGRATIONS = {}; // name -> async (pool) => summary ; filled by server.js
function register(name, fn) {
  if (MIGRATIONS[name]) throw new Error("duplicate migration " + name);
  MIGRATIONS[name] = fn;
}

async function migrate() {
  const p = getPool();
  await p.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), result jsonb)");
  const done = new Set((await p.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const applied = [];
  for (const name of Object.keys(MIGRATIONS)) {
    if (done.has(name)) continue;
    const result = await MIGRATIONS[name](p);
    await p.query("INSERT INTO schema_migrations (name, result) VALUES ($1, $2)", [name, JSON.stringify(result || {})]);
    applied.push(name);
    console.log("[migrate] applied " + name + " " + JSON.stringify(result || {}));
  }
  return { applied, total: Object.keys(MIGRATIONS).length };
}

async function listMigrations() {
  const rows = (await getPool().query("SELECT name, applied_at FROM schema_migrations ORDER BY applied_at")).rows;
  const done = {}; rows.forEach((r) => { done[r.name] = r.applied_at; });
  return Object.keys(MIGRATIONS).map((name) => ({ name, appliedAt: done[name] || null }));
}

module.exports = { getPool, register, migrate, listMigrations, MIGRATIONS };
