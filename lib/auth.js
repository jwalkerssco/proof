"use strict";
/* lib/auth.js -- sessions and PINs. Small on purpose.
 *
 * PIN storage: "s2:<salt>:<scrypt-hex>", verified timing-safe. Non-recoverable;
 * an admin resets, never reads.
 *
 * Sessions: one row per live token in proof_sessions, 60-day expiry enforced
 * lazily on read (an expired row lingers until someone presents it, or the
 * nightly prune). The token travels in the x-auth-token header. A DB error
 * while resolving answers 503, never 401 -- a transient outage must not make
 * the phone throw its session away.
 */
const crypto = require("crypto");

const SESSION_MS = 60 * 86400000;

function makeToken() { return crypto.randomBytes(24).toString("hex"); }
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  return "s2:" + salt + ":" + crypto.scryptSync(String(pin == null ? "" : pin), salt, 32).toString("hex");
}
function verifyPin(stored, pin) {
  if (stored == null || stored === "") return false;
  const parts = String(stored).split(":");
  if (parts.length !== 3 || parts[0] !== "s2") return false;
  try {
    const got = crypto.scryptSync(String(pin == null ? "" : pin), parts[1], 32);
    const want = Buffer.from(parts[2], "hex");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) { return false; }
}

function create(getPool) {
  const pool = () => getPool();

  async function migrateSessions(p) {
    await p.query(
      "CREATE TABLE IF NOT EXISTS proof_sessions (" +
      "  token      text PRIMARY KEY," +
      "  person_id  text NOT NULL," +
      "  branch_id  text NOT NULL," +
      "  name       text NOT NULL DEFAULT ''," +
      "  role       text NOT NULL," +
      "  created_at timestamptz NOT NULL DEFAULT now()," +
      "  expires_at timestamptz NOT NULL" +
      ")");
    await p.query("CREATE INDEX IF NOT EXISTS proof_sessions_person_idx ON proof_sessions (person_id)");
    await p.query("CREATE INDEX IF NOT EXISTS proof_sessions_exp_idx ON proof_sessions (expires_at)");
    return { table: "proof_sessions" };
  }

  // Awaited: a returned token is durably resolvable before the client uses it.
  async function _sessionEstablish(token, sess) {
    await pool().query(
      "INSERT INTO proof_sessions (token, person_id, branch_id, name, role, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [token, String(sess.id), String(sess.branch), String(sess.name || ""), String(sess.role), new Date(sess.exp).toISOString()]
    );
  }
  async function resolveToken(token) {
    if (!token) return null;
    const r = await pool().query("SELECT person_id, branch_id, name, role, expires_at FROM proof_sessions WHERE token = $1", [token]);
    if (!r.rows.length) return null;
    const row = r.rows[0];
    if (new Date(row.expires_at).getTime() < Date.now()) { await pool().query("DELETE FROM proof_sessions WHERE token = $1", [token]).catch(() => {}); return null; }
    return { id: row.person_id, branch: row.branch_id, name: row.name, role: row.role };
  }
  async function logout(token) { if (token) await pool().query("DELETE FROM proof_sessions WHERE token = $1", [token]); }
  async function revokeSessionsFor(personId) {
    const r = await pool().query("DELETE FROM proof_sessions WHERE person_id = $1", [String(personId)]);
    return r.rowCount || 0;
  }
  async function pruneExpired() {
    const r = await pool().query("DELETE FROM proof_sessions WHERE expires_at < now()");
    return r.rowCount || 0;
  }

  function roleSatisfies(have, want) { return have === want; }
  function requireRole(...roles) {
    return async (req, res, next) => {
      let s = null;
      try { s = await resolveToken(req.get("x-auth-token")); }
      catch (e) { console.error("[auth] resolve error:", e && e.message); return res.status(503).json({ error: "auth temporarily unavailable" }); }
      if (!s) return res.status(401).json({ error: "auth required" });
      if (roles.length && !roles.some((w) => roleSatisfies(s.role, w))) return res.status(403).json({ error: "forbidden" });
      req.session = s; next();
    };
  }

  return { SESSION_MS, makeToken, hashPin, verifyPin, migrateSessions, _sessionEstablish, resolveToken, logout, revokeSessionsFor, pruneExpired, requireRole };
}

module.exports = { create, hashPin, verifyPin, makeToken, SESSION_MS };
