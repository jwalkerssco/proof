"use strict";
/* proof/index.js -- Proof: the standalone merchandiser app.
   ============================================================================
   create(deps) shape: server.js hands this module the pool, the session/PIN
   primitives from lib/auth.js, and BRANCHES. Owns the proof_* tables
   (proof/schema.js) and nothing else.

   THINGS THAT ARE DELIBERATE:

   1. Fresh build. No relation to the old merch_* tables/data -- confirmed with
      Jess: this is a clean start, not a migration of the old rows.

   2. The team + weekly block schedule is carried forward from the shipped
      merch code because it's proven and matches the real route sheet (fixed
      route, rotating team, truck-day start times, repeat "pull" visits). The
      dated per-person schedule the original merch design also built was never
      wired into a screen and is NOT carried forward.

   3. A block's roster is its team(s)' members PLUS whoever is added directly
      via proof_block_members -- the door for "move a specific person onto a
      day without touching their team" (a call-off swap, an extra body on a
      truck day). Additive only in v1.

   4. The visit gate (one open visit at a time, DB-enforced via a partial
      unique index) is the actual point of this app: Start Visit -> sections
      -> item results + photos -> End Visit. Do not persist a timer -- persist
      timestamps and derive elapsed on read. A forgotten close stamps
      effective_end_at from the last recorded event, never wall-clock now(),
      so a visit closed an hour late from the next store doesn't fabricate an
      hour of work.

   5. GPS is stamp-and-flag, never block. A denied permission is a normal,
      recorded outcome, not an error.

   6. Every read swallows 42P01 into pending:true, so the window between a
      deploy starting and its migration finishing answers "setting up" rather
      than a 500.                                                             */

function newDeviceId() { return require("crypto").randomBytes(16).toString("hex"); }
function missingTable(e) { return !!e && (e.code === "42P01" || e.code === "42703"); }
function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40); }
function clip(v, n) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n || 200); }

const ROLES = require("./roles");
const { PROOF_MAX_FAILED, PROOF_LOCKOUT_MIN, proofSessionRole, proofBranchEnabled } = ROLES;

const TRUCK_START = "04:30", DEFAULT_START = "08:00";
// Points awarded on a MANUAL End Visit -- the only close that is evidence of
// work. Awarded rows, never a derived aggregate (proof_points).
const POINTS_PER_VISIT = 10, POINTS_PER_PHOTO = 1, POINTS_PHOTO_CAP = 10;

// Pure -- the truck-day default rule (S027 lesson, carried forward): flipping
// the truck flag re-defaults the start time UNLESS the SAME call also passed
// an explicit startTime. "mark as truck day" must not silently leave an
// 08:00 start on a 4:30 shift, and an explicit time in the same call must
// always win over the default.
function resolveBlockStart(current, patch) {
  if (patch.startTime != null) return patch.startTime;
  if (patch.truck != null && !!patch.truck !== !!current.truck) return patch.truck ? TRUCK_START : DEFAULT_START;
  return current.startTime;
}

// Pure -- id derives from the item number when present, over the name slug,
// so renaming a product doesn't orphan its plan-item rows (the 029 lesson).
function deriveProductId(o) { return o.id || (o.itemNo ? "no-" + slug(o.itemNo) : slug(o.name)); }

// Pure -- a merchandiser's day is every block where either their team is
// assigned OR they were added individually (the "move people around" door).
function dayBlocksFor(dayBlocks, teamId, personId) {
  return (dayBlocks || []).filter((b) => (teamId && b.teamIds.indexOf(teamId) !== -1) || (b.members || []).some((m) => m.id === personId));
}

const STORE_HEADERS = { name: ["name", "store", "account", "storename"], chain: ["chain"], addr: ["address", "addr", "street"],
  city: ["city"], state: ["state", "st"], zip: ["zip", "zipcode", "postal"], route: ["route", "territory"], id: ["id", "storeid", "store#", "store #"] };
function colMap(header) {
  const norm = header.map((h) => String(h || "").trim().toLowerCase());
  const map = {};
  Object.keys(STORE_HEADERS).forEach((k) => { const i = norm.findIndex((h) => STORE_HEADERS[k].indexOf(h) !== -1); if (i !== -1) map[k] = i; });
  return map;
}
const PROD_HEADERS = { name: ["name", "product", "description"], brand: ["brand"], pack: ["pack", "package"], itemNo: ["item no", "itemno", "item#", "item #", "sku"] };
function prodColMap(header) {
  const norm = header.map((h) => String(h || "").trim().toLowerCase());
  const map = {};
  Object.keys(PROD_HEADERS).forEach((k) => { const i = norm.findIndex((h) => PROD_HEADERS[k].indexOf(h) !== -1); if (i !== -1) map[k] = i; });
  return map;
}
function looksLikeHeader(row) {
  return row.some((c) => /[a-z]/i.test(String(c || ""))) && !row.every((c) => /^\d+$/.test(String(c || "").trim()));
}

function create(deps) {
  const D = deps;
  const pool = () => D.getPool();

  /* ============================== Identity ============================== */

  async function loginOptions() {
    try {
      const r = await pool().query(
        "SELECT p.id, p.name, p.role FROM proof_people p JOIN proof_credentials c ON c.id = p.id " +
        "WHERE p.active ORDER BY (p.role='admin') DESC, p.name"
      );
      return { people: r.rows };
    } catch (e) {
      if (missingTable(e)) return { people: [], pending: true };
      throw e;
    }
  }

  async function _deviceCheck(personId, deviceId, personRole) {
    if (!deviceId) return { ok: true, needsDevice: true }; // no device id sent -- older client, don't block
    // An admin is the approver -- they can never be made to wait on an
    // approval, or the seeded admin locks themself out from a second browser.
    if (personRole === "admin") {
      await pool().query(
        "INSERT INTO proof_devices (merch_id, device_id, approved_at) VALUES ($1,$2, now()) " +
        "ON CONFLICT (merch_id, device_id) DO UPDATE SET last_seen = now(), approved_at = COALESCE(proof_devices.approved_at, now()), revoked_at = NULL",
        [personId, deviceId]);
      return { ok: true };
    }
    const r = await pool().query(
      "SELECT device_id, revoked_at, approved_at FROM proof_devices WHERE merch_id = $1", [personId]
    );
    // Approved AND not revoked. A row that exists but is unapproved is the
    // pending case below -- it must not log in just because it has a row.
    if (r.rows.some((x) => x.device_id === deviceId && !x.revoked_at && x.approved_at)) {
      await pool().query("UPDATE proof_devices SET last_seen = now() WHERE merch_id = $1 AND device_id = $2", [personId, deviceId]);
      return { ok: true };
    }
    // No APPROVED device yet for this person: bind this one automatically.
    // Approval friction exists for a SECOND phone, not the first login on the
    // phone they were handed -- and a stray pending row must not count.
    if (!r.rows.some((x) => x.approved_at && !x.revoked_at)) {
      await pool().query(
        "INSERT INTO proof_devices (merch_id, device_id, approved_at) VALUES ($1,$2, now()) " +
        "ON CONFLICT (merch_id, device_id) DO UPDATE SET approved_at = now(), last_seen = now()",
        [personId, deviceId]
      );
      return { ok: true };
    }
    // A different, unbound device -- fails closed with a distinct status the
    // UI can explain, and leaves a row an admin can approve.
    const already = r.rows.find((x) => x.device_id === deviceId);
    if (already && already.revoked_at) return { ok: false, reason: "device_revoked" };
    if (!already) {
      await pool().query(
        "INSERT INTO proof_devices (merch_id, device_id) VALUES ($1,$2) ON CONFLICT (merch_id, device_id) DO UPDATE SET last_seen = now()",
        [personId, deviceId]
      );
    }
    return { ok: false, reason: "device_pending" };
  }

  async function login(id, pin, opts) {
    opts = opts || {};
    let row = null;
    try {
      const r = await pool().query("SELECT * FROM proof_people WHERE id = $1", [String(id || "")]);
      if (!r.rows.length) return { error: "invalid" };
      row = r.rows[0];
    } catch (e) {
      if (missingTable(e)) return { error: "invalid", pending: true };
      throw e;
    }
    if (!row.active) return { error: "invalid" };
    if (!proofBranchEnabled(row.branch_id)) return { error: "invalid" };
    if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) return { error: "invalid" };

    const cred = await pool().query("SELECT hash FROM proof_credentials WHERE id = $1", [row.id]);
    const ok = cred.rows.length && D.verifyPin(cred.rows[0].hash, pin);
    if (!ok) {
      // Brute-force counter lives in Postgres, not memory -- a 4-digit PIN is
      // guessable in seconds and an in-memory counter resets on every deploy.
      const failed = (row.failed_attempts || 0) + 1;
      const lock = failed >= PROOF_MAX_FAILED ? new Date(Date.now() + PROOF_LOCKOUT_MIN * 60000) : null;
      await pool().query("UPDATE proof_people SET failed_attempts = $2, locked_until = $3 WHERE id = $1", [row.id, failed, lock]);
      return { error: "invalid" };
    }

    const dev = await _deviceCheck(row.id, opts.deviceId, row.role);
    if (!dev.ok) return { error: dev.reason };

    await pool().query("UPDATE proof_people SET failed_attempts = 0, locked_until = NULL WHERE id = $1", [row.id]);

    const who = { role: proofSessionRole(row.role), id: row.id, name: row.name, branch: row.branch_id };
    const token = D.makeToken();
    await D._sessionEstablish(token, Object.assign({}, who, { exp: Date.now() + D.SESSION_MS }));
    return { token, ...who };
  }

  async function bootstrap(session) {
    const isAdmin = session.role === "proofadmin";
    if (isAdmin) {
      const [ppl, tms] = await Promise.all([people(session.branch), teams(session.branch)]);
      return { me: { id: session.id, name: session.name, role: "admin" }, people: ppl.people, teams: tms.teams, date: _today() };
    }
    const today = _today();
    const tomorrow = _dateAdd(today, 1);
    const [day, next] = await Promise.all([myDay(session.branch, session.id, today), myDay(session.branch, session.id, tomorrow)]);
    return { me: { id: session.id, name: session.name, role: "merch" }, date: today, myDay: day, tomorrow: next };
  }

  async function setPin(id, pin) {
    if (!/^\d{4,6}$/.test(String(pin || ""))) return { error: "pin must be 4-6 digits" };
    const hash = D.hashPin(pin);
    await pool().query(
      "INSERT INTO proof_credentials (id, hash) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET hash = EXCLUDED.hash, updated_at = now()",
      [id, hash]
    );
    // Otherwise the fix for "I am locked out" doesn't actually unlock anything.
    await pool().query("UPDATE proof_people SET failed_attempts = 0, locked_until = NULL WHERE id = $1", [id]);
    return { ok: true };
  }

  async function addPerson(o) {
    const branch = o.branch;
    if (!D.BRANCHES[branch]) return { error: "unknown branch" };
    if (!proofBranchEnabled(branch)) return { error: "Proof is not enabled for this branch yet" };
    if (!clip(o.name, 80)) return { error: "Name is required" };
    if (!/^\d{4,6}$/.test(String(o.pin || ""))) return { error: "PIN must be 4-6 digits" };
    const role = o.role === "admin" ? "admin" : "merch";
    const id = (role === "admin" ? "pf-adm-" : "pf-") + slug(o.name) + "-" + Math.random().toString(36).slice(2, 6);
    await pool().query(
      "INSERT INTO proof_people (id, branch_id, role, name, dm) VALUES ($1,$2,$3,$4,$5)",
      [id, branch, role, clip(o.name, 80), o.dm ? clip(o.dm, 80) : null]
    );
    await setPin(id, o.pin);
    return { ok: true, id };
  }

  async function setActive(id, active) {
    await pool().query("UPDATE proof_people SET active = $2, updated_at = now() WHERE id = $1", [id, !!active]);
    if (!active) await dropSessions(id);
    return { ok: true };
  }

  async function dropSessions(id) { return D.revokeSessionsFor(id); }

  async function setPersonTeam(branch, personId, teamId) {
    await pool().query("UPDATE proof_people SET team_id = $2, updated_at = now() WHERE id = $1 AND branch_id = $3", [personId, teamId || null, branch]);
    return { ok: true };
  }

  async function people(branch) {
    const r = await pool().query(
      "SELECT p.id, p.name, p.role, p.dm, p.team_id, p.active, p.locked_until, (c.hash IS NOT NULL) AS has_pin, " +
      "(SELECT count(*) FROM proof_devices d WHERE d.merch_id = p.id AND d.approved_at IS NOT NULL AND d.revoked_at IS NULL) AS devices " +
      "FROM proof_people p LEFT JOIN proof_credentials c ON c.id = p.id " +
      "WHERE p.branch_id = $1 ORDER BY (p.role='admin') DESC, p.name", [branch]
    );
    return { people: r.rows.map((x) => ({ id: x.id, name: x.name, role: x.role, dm: x.dm, teamId: x.team_id, active: x.active,
      locked: !!(x.locked_until && new Date(x.locked_until).getTime() > Date.now()), hasPin: x.has_pin, devices: Number(x.devices || 0) })) };
  }

  /* ============================== Devices ================================ */

  async function devicesPending(branch) {
    const r = await pool().query(
      "SELECT d.merch_id, d.device_id, d.first_seen, d.last_seen, p.name FROM proof_devices d " +
      "JOIN proof_people p ON p.id = d.merch_id " +
      "WHERE p.branch_id = $1 AND d.approved_at IS NULL AND d.revoked_at IS NULL ORDER BY d.first_seen", [branch]
    );
    return { pending: r.rows };
  }

  async function deviceApprove(merchId, deviceId, approvedBy) {
    await pool().query("UPDATE proof_devices SET approved_by = $3, approved_at = now() WHERE merch_id = $1 AND device_id = $2", [merchId, deviceId, approvedBy || null]);
    return { ok: true };
  }

  async function deviceRevoke(merchId, deviceId) {
    await pool().query("UPDATE proof_devices SET revoked_at = now() WHERE merch_id = $1 AND device_id = $2", [merchId, deviceId]);
    return { ok: true };
  }

  async function devicesFor(merchId) {
    const r = await pool().query("SELECT device_id, label, first_seen, last_seen, approved_at, revoked_at FROM proof_devices WHERE merch_id = $1 ORDER BY first_seen", [merchId]);
    return { devices: r.rows };
  }

  /* ============================== Dates =================================== */
  // UTC-epoch based, never local-time strings -- same discipline as the
  // shipped merch code (a store visit date must not drift with the device's
  // timezone or DST).
  const DAY_MS = 86400000;
  function _today() { return new Date().toISOString().slice(0, 10); }
  function _dateAdd(ymd, days) { return new Date(new Date(ymd + "T00:00:00Z").getTime() + days * DAY_MS).toISOString().slice(0, 10); }
  function _weekday(ymd) { return new Date(ymd + "T00:00:00Z").getUTCDay(); }

  /* ============================== Stores =================================== */

  async function stores(branch, o) {
    o = o || {};
    const args = [branch], where = ["branch_id = $1"];
    if (!o.includeClosed) where.push("active");
    if (o.route) { args.push(o.route); where.push("route = $" + args.length); }
    if (o.q) { args.push("%" + o.q.toLowerCase() + "%"); where.push("lower(name) LIKE $" + args.length); }
    const limit = Math.min(500, parseInt(o.limit, 10) || 200);
    const r = await pool().query(`SELECT * FROM proof_stores WHERE ${where.join(" AND ")} ORDER BY lower(name) LIMIT ${limit}`, args);
    return { stores: r.rows };
  }

  async function storeDetail(branch, storeId) {
    const [s, plan] = await Promise.all([
      pool().query("SELECT * FROM proof_stores WHERE branch_id = $1 AND id = $2", [branch, storeId]),
      planItems(branch, storeId),
    ]);
    return { store: s.rows[0] || null, plan };
  }

  async function uploadStores(branch, rows, o) {
    o = o || {};
    if (!proofBranchEnabled(branch)) return { error: "Proof is not enabled for this branch yet" };
    if (!Array.isArray(rows) || !rows.length) return { error: "no rows" };
    const header = rows[0];
    const map = colMap(header);
    if (map.name == null) return { error: "couldn't find a name column" };
    const parsed = rows.slice(1).map((r, i) => {
      const name = clip(r[map.name], 120);
      if (!name) return null;
      return {
        id: map.id != null && r[map.id] ? clip(r[map.id], 40) : slug(name) + "-" + i,
        name, chain: map.chain != null ? clip(r[map.chain], 80) : null,
        addr: map.addr != null ? clip(r[map.addr], 160) : null, city: map.city != null ? clip(r[map.city], 80) : null,
        state: map.state != null ? clip(r[map.state], 4) : null, zip: map.zip != null ? clip(r[map.zip], 12) : null,
        route: map.route != null ? clip(r[map.route], 40) : null,
      };
    }).filter(Boolean);

    const existing = await pool().query("SELECT id FROM proof_stores WHERE branch_id = $1 AND active", [branch]);
    const existingIds = new Set(existing.rows.map((x) => x.id));
    const newIds = new Set(parsed.map((x) => x.id));
    const missing = [...existingIds].filter((id) => !newIds.has(id));
    const blastPct = existingIds.size ? missing.length / existingIds.size : 0;
    if (o.closeMissing && blastPct > 0.4 && !o.force) {
      return { error: "would close " + Math.round(blastPct * 100) + "% of active stores -- pass force to override", preview: true, toClose: missing.length, parsed: parsed.length };
    }
    if (!o.apply) return { preview: true, parsed: parsed.length, willClose: o.closeMissing ? missing.length : 0 };

    // BATCHED, not row-at-a-time: a real store list is hundreds of rows, and
    // sequential inserts exceed the platform's request timeout -- the
    // connection drops and the browser reports "Failed to fetch" on a
    // perfectly good file.
    const up = await D.batchUpsert(pool(), {
      table: "proof_stores",
      columns: ["branch_id", "id", "name", "chain", "addr", "city", "state", "zip", "route", "active", "closed_at", "updated_at"],
      conflict: ["branch_id", "id"],
      rows: parsed.map((s) => [branch, s.id, s.name, s.chain, s.addr, s.city, s.state, s.zip, s.route, true, null, new Date()]),
    });
    if (o.closeMissing && missing.length) {
      await pool().query("UPDATE proof_stores SET active=false, closed_at=now() WHERE branch_id=$1 AND id = ANY($2)", [branch, missing]);
    }
    return { ok: true, upserted: up.written, duplicates: up.collapsed, closed: o.closeMissing ? missing.length : 0 };
  }

  /* ============================== Teams + week board ======================= */

  const TEAM_COLORS = ["slate", "navy", "gold", "green", "rose", "teal"];

  async function teams(branch) {
    const r = await pool().query("SELECT * FROM proof_teams WHERE branch_id = $1 AND active ORDER BY sort, name", [branch]);
    return { teams: r.rows.map((t) => ({ id: t.id, name: t.name, color: t.color, sort: t.sort })) };
  }

  async function teamSave(branch, o) {
    const id = o.id || slug(o.name);
    const sortR = await pool().query("SELECT COALESCE(MAX(sort),0)+1 AS n FROM proof_teams WHERE branch_id=$1", [branch]);
    await pool().query(
      "INSERT INTO proof_teams (id, branch_id, name, color, sort) VALUES ($1,$2,$3,$4,$5) " +
      "ON CONFLICT (branch_id, id) DO UPDATE SET name=EXCLUDED.name, color=COALESCE($4, proof_teams.color), active=true",
      [id, branch, clip(o.name, 40), o.color || TEAM_COLORS[0], o.id ? 0 : sortR.rows[0].n]
    );
    return { ok: true, id };
  }

  async function teamRemove(branch, id) {
    await pool().query("UPDATE proof_teams SET active=false WHERE branch_id=$1 AND id=$2", [branch, id]);
    await pool().query("UPDATE proof_people SET team_id=NULL WHERE branch_id=$1 AND team_id=$2", [branch, id]);
    await pool().query("DELETE FROM proof_block_teams WHERE team_id = $1", [id]);
    return { ok: true };
  }

  async function week(branch) {
    const [blocksR, teamsR, storesR, membersR] = await Promise.all([
      pool().query("SELECT * FROM proof_week_blocks WHERE branch_id=$1 ORDER BY weekday, sort", [branch]),
      pool().query("SELECT block_id, team_id FROM proof_block_teams bt JOIN proof_week_blocks b ON b.id=bt.block_id WHERE b.branch_id=$1", [branch]),
      pool().query("SELECT bs.*, s.name AS store_name, (SELECT count(*) FROM proof_plan_items pi WHERE pi.branch_id=$1 AND pi.store_id=bs.store_id AND pi.active) AS mapped " +
        "FROM proof_block_stores bs JOIN proof_week_blocks b ON b.id=bs.block_id LEFT JOIN proof_stores s ON s.branch_id=$1 AND s.id=bs.store_id WHERE b.branch_id=$1 ORDER BY bs.seq", [branch]),
      pool().query("SELECT bm.block_id, bm.person_id, p.name FROM proof_block_members bm JOIN proof_week_blocks b ON b.id=bm.block_id JOIN proof_people p ON p.id=bm.person_id WHERE b.branch_id=$1", [branch]),
    ]);
    const teamIdsByBlock = {}, storesByBlock = {}, membersByBlock = {};
    teamsR.rows.forEach((x) => { (teamIdsByBlock[x.block_id] = teamIdsByBlock[x.block_id] || []).push(x.team_id); });
    storesR.rows.forEach((x) => { (storesByBlock[x.block_id] = storesByBlock[x.block_id] || []).push({ id: x.id, storeId: x.store_id, storeName: x.store_name, pull: x.pull, seq: x.seq, flags: x.flags, mapped: Number(x.mapped) }); });
    membersR.rows.forEach((x) => { (membersByBlock[x.block_id] = membersByBlock[x.block_id] || []).push({ id: x.person_id, name: x.name }); });
    const days = [[], [], [], [], [], [], []];
    blocksR.rows.forEach((b) => {
      days[b.weekday].push({
        id: b.id, sort: b.sort, startTime: b.start_time, truck: b.truck, note: b.note,
        teamIds: teamIdsByBlock[b.id] || [], stores: storesByBlock[b.id] || [], members: membersByBlock[b.id] || [],
      });
    });
    return { days };
  }

  async function blockAdd(branch, o) {
    const truck = !!o.truck;
    const start = o.startTime || (truck ? TRUCK_START : DEFAULT_START);
    const sortR = await pool().query("SELECT COALESCE(MAX(sort),0)+1 AS n FROM proof_week_blocks WHERE branch_id=$1 AND weekday=$2", [branch, o.weekday]);
    const r = await pool().query(
      "INSERT INTO proof_week_blocks (branch_id, weekday, sort, start_time, truck, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [branch, o.weekday, o.sort != null ? o.sort : sortR.rows[0].n, start, truck, o.note || null]
    );
    const blockId = r.rows[0].id;
    for (const teamId of (o.teamIds || [])) await pool().query("INSERT INTO proof_block_teams (block_id, team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [blockId, teamId]);
    return { ok: true, id: blockId };
  }

  async function blockUpdate(branch, id, patch) {
    const cur = await pool().query("SELECT * FROM proof_week_blocks WHERE id=$1 AND branch_id=$2", [id, branch]);
    if (!cur.rows.length) return { error: "not found" };
    const row = cur.rows[0];
    const fields = [], args = [id];
    function set(col, val) { args.push(val); fields.push(col + " = $" + args.length); }
    if (patch.weekday != null) set("weekday", patch.weekday);
    if (patch.sort != null) set("sort", patch.sort);
    if (patch.note !== undefined) set("note", patch.note || null);
    if (patch.truck != null) set("truck", !!patch.truck);
    // resolveBlockStart is the pure rule (see top of file, tested in
    // test-proof.js): an explicit startTime always wins; otherwise flipping
    // truck re-defaults the start, and a truck value equal to the current
    // one changes nothing.
    if (patch.truck != null || patch.startTime != null) {
      set("start_time", resolveBlockStart({ startTime: row.start_time, truck: row.truck }, patch));
    }
    if (fields.length) await pool().query(`UPDATE proof_week_blocks SET ${fields.join(", ")}, updated_at = now() WHERE id = $1`, args);
    if (patch.teamIds) {
      await pool().query("DELETE FROM proof_block_teams WHERE block_id = $1", [id]);
      for (const teamId of patch.teamIds) await pool().query("INSERT INTO proof_block_teams (block_id, team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, teamId]);
    }
    return { ok: true };
  }

  async function blockRemove(branch, id) {
    await pool().query("DELETE FROM proof_week_blocks WHERE id=$1 AND branch_id=$2", [id, branch]);
    return { ok: true };
  }

  // Adding the same store to the same block twice creates a "2nd pull" --
  // pull is COALESCE(max(pull),0)+1 per (block_id, store_id).
  async function blockStoreAdd(branch, blockId, storeId, flags) {
    const r = await pool().query("SELECT COALESCE(MAX(pull),0)+1 AS n FROM proof_block_stores WHERE block_id=$1 AND store_id=$2", [blockId, storeId]);
    const sortR = await pool().query("SELECT COALESCE(MAX(seq),0)+1 AS n FROM proof_block_stores WHERE block_id=$1", [blockId]);
    await pool().query("INSERT INTO proof_block_stores (block_id, store_id, pull, seq, flags) VALUES ($1,$2,$3,$4,$5)", [blockId, storeId, r.rows[0].n, sortR.rows[0].n, flags || null]);
    return { ok: true, pull: r.rows[0].n };
  }

  // Without a rowId, removes the HIGHEST-pull row for that store first --
  // "remove" on a twice-pulled store peels off the 2nd pull, not the 1st.
  async function blockStoreRemove(blockId, storeId, rowId) {
    if (rowId) { await pool().query("DELETE FROM proof_block_stores WHERE id=$1", [rowId]); return { ok: true }; }
    await pool().query(
      "DELETE FROM proof_block_stores WHERE id = (SELECT id FROM proof_block_stores WHERE block_id=$1 AND store_id=$2 ORDER BY pull DESC LIMIT 1)",
      [blockId, storeId]
    );
    return { ok: true };
  }

  async function blockStoreFlags(rowId, flags) {
    await pool().query("UPDATE proof_block_stores SET flags = $2 WHERE id = $1", [rowId, flags || null]);
    return { ok: true };
  }

  // "Move people around as needed" -- add/remove a specific person on a
  // specific block, independent of their team. This is the door for a
  // one-off coverage swap without touching the recurring team template.
  async function blockMemberAdd(blockId, personId, addedBy) {
    await pool().query("INSERT INTO proof_block_members (block_id, person_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [blockId, personId, addedBy || null]);
    return { ok: true };
  }
  async function blockMemberRemove(blockId, personId) {
    await pool().query("DELETE FROM proof_block_members WHERE block_id=$1 AND person_id=$2", [blockId, personId]);
    return { ok: true };
  }

  // A merchandiser's day: every block, that weekday, where either their team
  // is assigned OR they were added individually.
  async function myDay(branch, personId, ymd) {
    const person = await pool().query("SELECT team_id FROM proof_people WHERE id = $1", [personId]);
    const teamId = person.rows[0] ? person.rows[0].team_id : null;
    const wd = _weekday(ymd);
    const w = await week(branch);
    const blocks = dayBlocksFor(w.days[wd], teamId, personId);
    return { date: ymd, weekday: wd, blocks };
  }

  /* ============================== Catalog ================================== */

  const PROD_HEADERS = { name: ["name", "product", "description"], brand: ["brand"], pack: ["pack", "package"], itemNo: ["item no", "itemno", "item#", "item #", "sku"] };
  function _prodColMap(header) {
    const norm = header.map((h) => String(h || "").trim().toLowerCase());
    const map = {};
    Object.keys(PROD_HEADERS).forEach((k) => { const i = norm.findIndex((h) => PROD_HEADERS[k].indexOf(h) !== -1); if (i !== -1) map[k] = i; });
    return map;
  }

  async function products(branch, o) {
    o = o || {};
    const args = [branch], where = ["branch_id = $1", "active"];
    if (o.q) { args.push("%" + o.q.toLowerCase() + "%"); where.push("lower(name) LIKE $" + args.length); }
    const limit = Math.min(500, parseInt(o.limit, 10) || 200);
    const r = await pool().query(`SELECT * FROM proof_products WHERE ${where.join(" AND ")} ORDER BY lower(name) LIMIT ${limit}`, args);
    // Camel-case the boundary -- a leaked raw column name (item_no) is how a
    // client ends up reading undefined (the lesson the shipped merch code
    // left a comment about).
    return { products: r.rows.map((p) => ({ id: p.id, name: p.name, brand: p.brand, pack: p.pack, itemNo: p.item_no })) };
  }

  async function productSave(branch, o) {
    const pid = deriveProductId(o);
    await pool().query(
      "INSERT INTO proof_products (branch_id, id, item_no, name, brand, pack) VALUES ($1,$2,$3,$4,$5,$6) " +
      "ON CONFLICT (branch_id, id) DO UPDATE SET item_no=EXCLUDED.item_no, name=EXCLUDED.name, brand=EXCLUDED.brand, pack=EXCLUDED.pack, active=true",
      [branch, pid, o.itemNo || null, clip(o.name, 120), o.brand ? clip(o.brand, 60) : null, o.pack ? clip(o.pack, 40) : null]
    );
    return { ok: true, id: pid };
  }

  async function productRemove(branch, id) {
    await pool().query("UPDATE proof_products SET active=false WHERE branch_id=$1 AND id=$2", [branch, id]);
    // A location for a product nobody carries is noise on a merchandiser's screen.
    await pool().query("UPDATE proof_plan_items SET active=false WHERE branch_id=$1 AND product_id=$2", [branch, id]);
    return { ok: true };
  }

  async function productsUpload(branch, rows, o) {
    o = o || {};
    if (!Array.isArray(rows) || !rows.length) return { error: "no rows" };
    const hasHeader = looksLikeHeader(rows[0]);
    const map = hasHeader ? prodColMap(rows[0]) : {};
    const body = hasHeader ? rows.slice(1) : rows;
    let saved = 0, skipped = 0;
    const keep = [];
    for (const r of body) {
      let name, itemNo;
      if (map.name != null || map.itemNo != null) {
        name = map.name != null ? clip(r[map.name], 120) : "";
        itemNo = map.itemNo != null ? clip(r[map.itemNo], 20) : "";
      } else {
        // No header: guess by shape -- mostly-digits column is the item number.
        const mostlyDigits = (v) => /^\d{3,}$/.test(String(v || "").trim());
        if (mostlyDigits(r[0])) { itemNo = clip(r[0], 20); name = clip(r[1], 120); }
        else { name = clip(r[0], 120); itemNo = mostlyDigits(r[1]) ? clip(r[1], 20) : ""; }
      }
      if (!name) { skipped++; continue; }
      const brand = map.brand != null ? clip(r[map.brand], 60) : null;
      const pack = map.pack != null ? clip(r[map.pack], 40) : null;
      keep.push([branch, deriveProductId({ name, itemNo: itemNo || null }), itemNo || null, name, brand, pack, true]);
      saved++;
    }
    if (o.apply === false) return { ok: true, saved, skipped, headerSeen: hasHeader };
    // Batched for the same reason as the store upload -- a catalog is
    // thousands of rows and row-at-a-time times the request out.
    const up = await D.batchUpsert(pool(), {
      table: "proof_products",
      columns: ["branch_id", "id", "item_no", "name", "brand", "pack", "active"],
      conflict: ["branch_id", "id"],
      rows: keep,
    });
    return { ok: true, saved: up.written, skipped, duplicates: up.collapsed, headerSeen: hasHeader };
  }

  async function sections(branch, storeId) {
    const r = await pool().query("SELECT id, label, ord FROM proof_sections WHERE branch_id=$1 AND store_id=$2 AND active ORDER BY ord, label", [branch, storeId]);
    return { sections: r.rows };
  }

  async function sectionSave(branch, storeId, o) {
    if (o.id) { await pool().query("UPDATE proof_sections SET label=$3, ord=$4 WHERE id=$1 AND branch_id=$2", [o.id, branch, clip(o.label, 60), o.ord || 0]); return { ok: true, id: o.id }; }
    const r = await pool().query("INSERT INTO proof_sections (branch_id, store_id, label, ord) VALUES ($1,$2,$3,$4) RETURNING id", [branch, storeId, clip(o.label, 60), o.ord || 0]);
    return { ok: true, id: r.rows[0].id };
  }

  async function sectionRemove(branch, id) {
    await pool().query("UPDATE proof_sections SET active=false WHERE id=$1 AND branch_id=$2", [id, branch]);
    return { ok: true };
  }

  // The merchandiser's actual checklist for a store, grouped by aisle --
  // same shape the shipped merch screen renders from.
  async function planItems(branch, storeId) {
    const r = await pool().query(
      "SELECT pi.id, pi.aisle, pi.bay, pi.shelf, pi.note, pi.section_id, s.label AS section_label, pr.id AS product_id, pr.name, pr.item_no, pr.brand " +
      "FROM proof_plan_items pi JOIN proof_products pr ON pr.branch_id=pi.branch_id AND pr.id=pi.product_id " +
      "LEFT JOIN proof_sections s ON s.id = pi.section_id " +
      "WHERE pi.branch_id=$1 AND pi.store_id=$2 AND pi.active " +
      "ORDER BY regexp_replace(COALESCE(pi.aisle,''), '[^0-9]', '', 'g')::text::int NULLS LAST, pi.aisle, pi.seq",
      [branch, storeId]
    ).catch(() =>
      // Fallback if an aisle has no numeric prefix at all and the cast throws.
      pool().query(
        "SELECT pi.id, pi.aisle, pi.bay, pi.shelf, pi.note, pi.section_id, s.label AS section_label, pr.id AS product_id, pr.name, pr.item_no, pr.brand " +
        "FROM proof_plan_items pi JOIN proof_products pr ON pr.branch_id=pi.branch_id AND pr.id=pi.product_id " +
        "LEFT JOIN proof_sections s ON s.id = pi.section_id " +
        "WHERE pi.branch_id=$1 AND pi.store_id=$2 AND pi.active ORDER BY pi.aisle, pi.seq", [branch, storeId]
      )
    );
    const groups = {};
    r.rows.forEach((x) => {
      const key = x.aisle || "—";
      (groups[key] = groups[key] || []).push({ id: x.id, productId: x.product_id, name: x.name, itemNo: x.item_no, brand: x.brand, bay: x.bay, shelf: x.shelf, note: x.note, sectionId: x.section_id, sectionLabel: x.section_label });
    });
    return { storeId, count: r.rows.length, groups: Object.keys(groups).map((aisle) => ({ aisle, items: groups[aisle] })) };
  }

  async function planItemSet(branch, o) {
    const sortR = await pool().query("SELECT COALESCE(MAX(seq),0)+1 AS n FROM proof_plan_items WHERE branch_id=$1 AND store_id=$2", [branch, o.storeId]);
    await pool().query(
      "INSERT INTO proof_plan_items (branch_id, store_id, section_id, product_id, aisle, bay, shelf, note, seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) " +
      "ON CONFLICT (branch_id, store_id, product_id, COALESCE(aisle,''), COALESCE(bay,''), COALESCE(shelf,'')) DO UPDATE SET " +
      "section_id=EXCLUDED.section_id, note=EXCLUDED.note, active=true, updated_at=now()",
      [branch, o.storeId, o.sectionId || null, o.productId, o.aisle || null, o.bay || null, o.shelf || null, o.note || null, sortR.rows[0].n]
    );
    return { ok: true };
  }

  async function planItemRemove(branch, id) {
    await pool().query("UPDATE proof_plan_items SET active=false WHERE id=$1 AND branch_id=$2", [id, branch]);
    return { ok: true };
  }

  // Most stores in a chain are laid out close enough that starting from a
  // sibling beats starting from nothing.
  async function planItemsCopy(branch, fromStore, toStore) {
    const src = await pool().query("SELECT * FROM proof_plan_items WHERE branch_id=$1 AND store_id=$2 AND active", [branch, fromStore]);
    for (const row of src.rows) {
      await planItemSet(branch, { storeId: toStore, sectionId: row.section_id, productId: row.product_id, aisle: row.aisle, bay: row.bay, shelf: row.shelf, note: row.note });
    }
    return { ok: true, copied: src.rows.length };
  }

  /* ============================== Visits =================================== */

  async function openVisitFor(merchId) {
    const r = await pool().query("SELECT * FROM proof_visits WHERE merch_id = $1 AND ended_at IS NULL", [merchId]);
    return r.rows[0] || null;
  }

  async function startVisit(session, o) {
    const open = await openVisitFor(session.id);
    if (open) return { open: true, visit: _visitOut(open) };
    let row;
    try {
      const r = await pool().query(
        "INSERT INTO proof_visits (branch_id, merch_id, store_id, block_id, lat, lng, accuracy_m, geo_denied, device_id) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [session.branch, session.id, o.storeId, o.blockId || null, o.lat != null ? o.lat : null, o.lng != null ? o.lng : null,
         o.accuracy != null ? o.accuracy : null, !!o.geoDenied, o.deviceId || null]
      );
      row = r.rows[0];
    } catch (e) {
      // The partial unique index is the real guarantee -- a race (two tabs,
      // a reconnect after an optimistic offline start) lands here instead of
      // creating a second open visit.
      if (e && e.code === "23505") { const now = await openVisitFor(session.id); return { open: true, visit: _visitOut(now) }; }
      throw e;
    }
    await pool().query("INSERT INTO proof_visit_events (visit_id, kind, at_client) VALUES ($1,'visit_start',$2)", [row.id, o.atClient ? new Date(o.atClient) : null]);
    return { ok: true, visit: _visitOut(row) };
  }

  function _visitOut(r) {
    return { id: r.id, storeId: r.store_id, blockId: r.block_id, startedAt: r.started_at, endedAt: r.ended_at,
      effectiveEndAt: r.effective_end_at, closeReason: r.close_reason, geoFlag: r.geo_flag, geoDenied: r.geo_denied };
  }

  // One open section at a time, enforced here rather than only in the UI so a
  // resumed offline draft cannot submit overlapping spans. Idempotent: the
  // client fires this on every interaction in a section (the merchandiser
  // never presses an "enter section" button -- timing is invisible to them,
  // S3.4), so re-entering the section that is already open is a no-op.
  async function _openSection(visitId) {
    const last = await pool().query(
      "SELECT kind, section_id FROM proof_visit_events WHERE visit_id=$1 AND kind IN ('section_enter','section_exit') ORDER BY seq DESC, id DESC LIMIT 1", [visitId]);
    const r = last.rows[0];
    return r && r.kind === "section_enter" ? r.section_id : null;
  }
  async function sectionEnter(visitId, sectionId, atClient) {
    if (sectionId == null) return { ok: true, skipped: true };
    const open = await _openSection(visitId);
    if (open != null && String(open) === String(sectionId)) return { ok: true, already: true };
    if (open != null) await _event(visitId, "section_exit", open, atClient);
    return _event(visitId, "section_enter", sectionId, atClient);
  }
  async function sectionExit(visitId, sectionId, atClient) { return _event(visitId, "section_exit", sectionId, atClient); }
  async function _event(visitId, kind, sectionId, atClient) {
    const seqR = await pool().query("SELECT COALESCE(MAX(seq),0)+1 AS n FROM proof_visit_events WHERE visit_id=$1", [visitId]);
    await pool().query("INSERT INTO proof_visit_events (visit_id, kind, section_id, at_client, seq) VALUES ($1,$2,$3,$4,$5)", [visitId, kind, sectionId || null, atClient ? new Date(atClient) : null, seqR.rows[0].n]);
    return { ok: true };
  }

  async function itemResult(visitId, planItemId, status, note) {
    await pool().query("INSERT INTO proof_item_results (visit_id, plan_item_id, status, note) VALUES ($1,$2,$3,$4)", [visitId, planItemId || null, status, note || null]);
    return { ok: true };
  }

  async function addPhoto(visitId, sectionId, dataUrl, mime) {
    const bytes = String(dataUrl || "");
    await pool().query("INSERT INTO proof_photos (visit_id, section_id, mime, bytes, byte_len) VALUES ($1,$2,$3,$4,$5)", [visitId, sectionId || null, mime || null, bytes, bytes.length]);
    return { ok: true };
  }

  // "I finished there": closes with effective_end_at = the last recorded
  // event, NEVER now() -- stamping now() from the next store's parking lot
  // would write a fictional extra hour into data a supplier sees.
  async function closeForgotten(visitId) {
    const last = await pool().query("SELECT MAX(at_server) AS at FROM proof_visit_events WHERE visit_id=$1", [visitId]);
    const eff = last.rows[0].at || new Date();
    await pool().query("UPDATE proof_visits SET ended_at=now(), effective_end_at=$2, close_reason='forgotten' WHERE id=$1 AND ended_at IS NULL", [visitId, eff]);
    return { ok: true };
  }

  async function endVisit(session, visitId, atClient) {
    const open = await openVisitFor(session.id);
    if (!open || String(open.id) !== String(visitId)) return { error: "no open visit" };
    const openSec = await _openSection(visitId);
    if (openSec != null) await _event(visitId, "section_exit", openSec, atClient);
    await _event(visitId, "visit_end", null, atClient);
    const r = await pool().query(
      "UPDATE proof_visits SET ended_at=now(), effective_end_at=now(), close_reason='manual', submitted_at=now() WHERE id=$1 RETURNING started_at, ended_at", [visitId]);
    const [items, photos] = await Promise.all([
      pool().query("SELECT count(DISTINCT plan_item_id) AS n FROM proof_item_results WHERE visit_id=$1", [visitId]),
      pool().query("SELECT count(*) AS n FROM proof_photos WHERE visit_id=$1", [visitId]),
    ]);
    const nItems = Number(items.rows[0].n), nPhotos = Number(photos.rows[0].n);
    const points = POINTS_PER_VISIT + Math.min(POINTS_PHOTO_CAP, nPhotos * POINTS_PER_PHOTO);
    const row = r.rows[0];
    const minutes = row ? Math.max(0, Math.round((new Date(row.ended_at) - new Date(row.started_at)) / 60000)) : null;
    const periodKey = String(row ? new Date(row.started_at).toISOString() : new Date().toISOString()).slice(0, 7);
    await awardPoints(session.branch, session.id, periodKey, points, "visit", visitId);
    return { ok: true, summary: { items: nItems, photos: nPhotos, points, minutes } };
  }

  // Every visit this merchandiser started on a day -- what Today marks as
  // done / in progress. Counts only; the photos themselves never ride here.
  async function myVisits(session, ymd) {
    const day = ymd || _today();
    const r = await pool().query(
      "SELECT v.id, v.store_id, v.started_at, v.ended_at, v.close_reason, " +
      "(SELECT count(DISTINCT plan_item_id) FROM proof_item_results i WHERE i.visit_id=v.id) AS items, " +
      "(SELECT count(*) FROM proof_photos ph WHERE ph.visit_id=v.id) AS photos " +
      "FROM proof_visits v WHERE v.merch_id=$1 AND v.started_at::date = $2::date ORDER BY v.started_at", [session.id, day]);
    return { date: day, visits: r.rows.map((x) => ({ id: x.id, storeId: x.store_id, startedAt: x.started_at, endedAt: x.ended_at, closeReason: x.close_reason, items: Number(x.items), photos: Number(x.photos) })) };
  }

  // Blocked at the next store (§3.1): renders a card naming the open visit
  // with two self-service ways out. Called by the client before allowing a
  // new Start Visit when one is already open somewhere else.
  async function blockedOpenVisit(session) {
    const open = await openVisitFor(session.id);
    if (!open) return null;
    const s = await pool().query("SELECT name FROM proof_stores WHERE branch_id=$1 AND id=$2", [session.branch, open.store_id]);
    return { visit: _visitOut(open), storeName: s.rows[0] ? s.rows[0].name : open.store_id };
  }

  // Nightly sweep: closes anything still open at end of day. close_reason
  // 'nightly' -- excluded from supplier-facing duration averages same as
  // 'forgotten'.
  async function nightlySweepOpenVisits() {
    const r = await pool().query(
      "SELECT id FROM proof_visits WHERE ended_at IS NULL AND started_at < now() - interval '18 hours'"
    );
    for (const row of r.rows) await closeForgotten(row.id).then(() => pool().query("UPDATE proof_visits SET close_reason='nightly' WHERE id=$1", [row.id]));
    return { closed: r.rows.length };
  }

  async function visitDetail(id) {
    const [v, events, results, photos] = await Promise.all([
      pool().query("SELECT * FROM proof_visits WHERE id=$1", [id]),
      pool().query("SELECT kind, section_id, at_client, at_server, seq FROM proof_visit_events WHERE visit_id=$1 ORDER BY seq", [id]),
      pool().query("SELECT plan_item_id, status, note, created_at FROM proof_item_results WHERE visit_id=$1", [id]),
      pool().query("SELECT id, section_id, mime, byte_len, taken_at FROM proof_photos WHERE visit_id=$1 ORDER BY taken_at", [id]),
    ]);
    if (!v.rows.length) return { error: "not found" };
    return { visit: _visitOut(v.rows[0]), events: events.rows, results: results.rows, photos: photos.rows };
  }

  // Admin: today's visits across their merchandisers -- in progress and done.
  async function liveCompletion(branch, ymd) {
    const day = ymd || _today();
    const r = await pool().query(
      "SELECT v.id, v.merch_id, p.name AS merch_name, v.store_id, s.name AS store_name, v.started_at, v.ended_at, v.close_reason, v.geo_flag " +
      "FROM proof_visits v JOIN proof_people p ON p.id=v.merch_id LEFT JOIN proof_stores s ON s.branch_id=v.branch_id AND s.id=v.store_id " +
      "WHERE v.branch_id=$1 AND v.started_at::date = $2::date ORDER BY v.started_at", [branch, day]
    );
    return { date: day, visits: r.rows.map((x) => ({ id: x.id, merchId: x.merch_id, merchName: x.merch_name, storeId: x.store_id, storeName: x.store_name, startedAt: x.started_at, endedAt: x.ended_at, closeReason: x.close_reason, geoFlag: x.geo_flag, inProgress: !x.ended_at })) };
  }

  // Time per section/store/chain. auto_closed (forgotten/next_visit/nightly)
  // excluded by default -- those durations are known-unknowns, not evidence.
  async function reporting(branch, o) {
    o = o || {};
    const args = [branch], where = ["v.branch_id = $1", "v.ended_at IS NOT NULL"];
    if (!o.includeAutoClosed) where.push("v.close_reason = 'manual'");
    if (o.from) { args.push(o.from); where.push("v.started_at >= $" + args.length); }
    if (o.to) { args.push(o.to); where.push("v.started_at <= $" + args.length); }
    const r = await pool().query(
      `SELECT v.store_id, s.name AS store_name, s.chain, COUNT(*) AS visits, ` +
      `AVG(EXTRACT(EPOCH FROM (v.effective_end_at - v.started_at))) AS avg_seconds ` +
      `FROM proof_visits v LEFT JOIN proof_stores s ON s.branch_id=v.branch_id AND s.id=v.store_id ` +
      `WHERE ${where.join(" AND ")} GROUP BY v.store_id, s.name, s.chain ORDER BY s.name`, args
    );
    return { rows: r.rows.map((x) => ({ storeId: x.store_id, storeName: x.store_name, chain: x.chain, visits: Number(x.visits), avgMinutes: x.avg_seconds ? Math.round(x.avg_seconds / 60) : null })) };
  }

  /* ============================== Points ==================================== */

  async function awardPoints(branch, merchId, periodKey, points, reason, visitId) {
    await pool().query("INSERT INTO proof_points (branch_id, merch_id, period_key, visit_id, points, reason) VALUES ($1,$2,$3,$4,$5,$6)", [branch, merchId, periodKey, visitId || null, points, reason || null]);
    return { ok: true };
  }

  async function leaderboard(branch, periodKey) {
    const r = await pool().query(
      "SELECT p.merch_id, pp.name, SUM(p.points) AS total FROM proof_points p JOIN proof_people pp ON pp.id=p.merch_id " +
      "WHERE p.branch_id=$1 AND p.period_key=$2 GROUP BY p.merch_id, pp.name ORDER BY total DESC", [branch, periodKey]
    );
    return { board: r.rows.map((x) => ({ merchId: x.merch_id, name: x.name, points: Number(x.total) })) };
  }

  return {
    loginOptions, login, bootstrap, setPin, addPerson, setActive, dropSessions, setPersonTeam, people,
    devicesPending, deviceApprove, deviceRevoke, devicesFor,
    stores, uploadStores, storeDetail,
    teams, teamSave, teamRemove, week, blockAdd, blockUpdate, blockRemove,
    blockStoreAdd, blockStoreRemove, blockStoreFlags, blockMemberAdd, blockMemberRemove, myDay,
    products, productSave, productRemove, productsUpload,
    sections, sectionSave, sectionRemove, planItems, planItemSet, planItemRemove, planItemsCopy,
    openVisitFor, startVisit, sectionEnter, sectionExit, itemResult, addPhoto, closeForgotten, endVisit,
    blockedOpenVisit, nightlySweepOpenVisits, visitDetail, myVisits, liveCompletion, reporting,
    awardPoints, leaderboard,
    _today, _dateAdd, _weekday, TRUCK_START, DEFAULT_START,
  };
}

module.exports = {
  create, ...ROLES,
  // Pure functions, exported for test-proof.js -- no DB, no network.
  resolveBlockStart, deriveProductId, dayBlocksFor, colMap, prodColMap, looksLikeHeader, slug,
  TRUCK_START, DEFAULT_START,
};
