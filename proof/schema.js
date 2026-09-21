"use strict";
/* proof/schema.js -- DDL for the proof_* tables, one function per migration.
 *
 * Registered in server.js (DB.register) and run at startup by lib/db.js, each
 * once. CREATE TABLE IF NOT EXISTS throughout, so re-running is a no-op.
 */

// hashPin is db.js-local (the 013 scrypt format), so the registry entry
// hands it in rather than this file requiring db.js back.
async function migrateIdentity(pool, hashPin) {
  const made = [];
  async function t(name, sql) { await pool.query(sql); made.push(name); }

  await t("proof_people",
    "CREATE TABLE IF NOT EXISTS proof_people (" +
    "  id              text PRIMARY KEY," +
    "  branch_id       text NOT NULL REFERENCES branches(id)," +
    "  role            text NOT NULL CHECK (role IN ('merch','admin'))," +
    "  name            text NOT NULL," +
    "  dm              text," +
    "  team_id         text," +
    "  active          boolean NOT NULL DEFAULT true," +
    "  failed_attempts integer NOT NULL DEFAULT 0," +
    "  locked_until    timestamptz," +
    "  created_at      timestamptz NOT NULL DEFAULT now()," +
    "  updated_at      timestamptz NOT NULL DEFAULT now()" +
    ")");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_people_active_idx ON proof_people (branch_id, role) WHERE active");

  await t("proof_credentials",
    "CREATE TABLE IF NOT EXISTS proof_credentials (" +
    "  id         text PRIMARY KEY REFERENCES proof_people(id) ON DELETE CASCADE," +
    "  hash       text NOT NULL," +
    "  algo       text NOT NULL DEFAULT 's2'," +
    "  updated_at timestamptz NOT NULL DEFAULT now()" +
    ")");

  await t("proof_devices",
    "CREATE TABLE IF NOT EXISTS proof_devices (" +
    "  merch_id     text NOT NULL REFERENCES proof_people(id) ON DELETE CASCADE," +
    "  device_id    text NOT NULL," +
    "  label        text," +
    "  first_seen   timestamptz NOT NULL DEFAULT now()," +
    "  last_seen    timestamptz NOT NULL DEFAULT now()," +
    "  approved_by  text," +
    "  approved_at  timestamptz," +
    "  revoked_at   timestamptz," +
    "  PRIMARY KEY (merch_id, device_id)" +
    ")");

  // Seed ONE admin so the app is enterable: every other person is created
  // from the Team tab, which needs a proofadmin session. Only when no admin
  // exists yet, so re-running never resets a PIN. Default PIN 2468 -- change
  // it from Team -> Reset PIN on first sign-in.
  let seeded = false;
  const have = await pool.query("SELECT 1 FROM proof_people WHERE role = 'admin' LIMIT 1");
  if (!have.rows.length && typeof hashPin === "function") {
    await pool.query(
      "INSERT INTO proof_people (id, branch_id, role, name) VALUES ('pf-admin', 'odessa', 'admin', 'Proof Admin') ON CONFLICT (id) DO NOTHING");
    await pool.query(
      "INSERT INTO proof_credentials (id, hash) VALUES ('pf-admin', $1) ON CONFLICT (id) DO NOTHING", [hashPin("2468")]);
    seeded = true;
  }

  return { migration: "002_identity", tables: made, seededAdmin: seeded, note: seeded ? "pf-admin created with PIN 2468 -- reset it on first sign-in" : "admin already present, nothing seeded" };
}

async function migrateOps(pool) {
  const made = [];
  async function t(name, sql) { await pool.query(sql); made.push(name); }

  await t("proof_stores",
    "CREATE TABLE IF NOT EXISTS proof_stores (" +
    "  branch_id    text NOT NULL REFERENCES branches(id)," +
    "  id           text NOT NULL," +
    "  name         text NOT NULL," +
    "  chain        text," +
    "  addr         text," +
    "  city         text," +
    "  state        text," +
    "  zip          text," +
    "  route        text," +
    "  lat          double precision," +
    "  lng          double precision," +
    "  geocoded_at  timestamptz," +
    "  geo_source   text," +
    "  active       boolean NOT NULL DEFAULT true," +
    "  closed_at    timestamptz," +
    "  created_at   timestamptz NOT NULL DEFAULT now()," +
    "  updated_at   timestamptz NOT NULL DEFAULT now()," +
    "  PRIMARY KEY (branch_id, id)" +
    ")");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_stores_active_idx ON proof_stores (branch_id, route) WHERE active");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_stores_name_idx ON proof_stores (branch_id, lower(name))");

  await t("proof_teams",
    "CREATE TABLE IF NOT EXISTS proof_teams (" +
    "  id         text NOT NULL," +
    "  branch_id  text NOT NULL REFERENCES branches(id)," +
    "  name       text NOT NULL," +
    "  color      text NOT NULL DEFAULT 'slate'," +
    "  sort       integer NOT NULL DEFAULT 0," +
    "  active     boolean NOT NULL DEFAULT true," +
    "  created_at timestamptz NOT NULL DEFAULT now()," +
    "  PRIMARY KEY (branch_id, id)" +
    ")");

  await t("proof_week_blocks",
    "CREATE TABLE IF NOT EXISTS proof_week_blocks (" +
    "  id         bigserial PRIMARY KEY," +
    "  branch_id  text NOT NULL REFERENCES branches(id)," +
    "  weekday    integer NOT NULL CHECK (weekday BETWEEN 0 AND 6)," + // 0=Sunday
    "  sort       integer NOT NULL DEFAULT 0," +
    "  start_time text NOT NULL DEFAULT '08:00'," + // HH:MM local
    "  truck      boolean NOT NULL DEFAULT false," +
    "  note       text," +
    "  created_at timestamptz NOT NULL DEFAULT now()," +
    "  updated_at timestamptz NOT NULL DEFAULT now()" +
    ")");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_week_blocks_day_idx ON proof_week_blocks (branch_id, weekday, sort)");

  await t("proof_block_teams",
    "CREATE TABLE IF NOT EXISTS proof_block_teams (" +
    "  block_id bigint NOT NULL REFERENCES proof_week_blocks(id) ON DELETE CASCADE," +
    "  team_id  text NOT NULL," +
    "  PRIMARY KEY (block_id, team_id)" +
    ")");

  // A block's roster is its assigned team(s)' members PLUS whoever is added
  // here directly. This is the "move people around as needed" door: an admin
  // can staff a specific block with a specific person without touching that
  // person's team assignment (a one-off coverage swap, a fill-in, an extra
  // body on a truck day) -- additive only, v1. Removing a person from a block
  // they're only on via their team means changing their team, same as today;
  // a person added here can be removed here without touching the team.
  await t("proof_block_members",
    "CREATE TABLE IF NOT EXISTS proof_block_members (" +
    "  block_id   bigint NOT NULL REFERENCES proof_week_blocks(id) ON DELETE CASCADE," +
    "  person_id  text NOT NULL REFERENCES proof_people(id) ON DELETE CASCADE," +
    "  added_by   text," +
    "  added_at   timestamptz NOT NULL DEFAULT now()," +
    "  PRIMARY KEY (block_id, person_id)" +
    ")");

  await t("proof_block_stores",
    "CREATE TABLE IF NOT EXISTS proof_block_stores (" +
    "  id       bigserial PRIMARY KEY," +
    "  block_id bigint NOT NULL REFERENCES proof_week_blocks(id) ON DELETE CASCADE," +
    "  store_id text NOT NULL," +
    "  pull     integer NOT NULL DEFAULT 1," +
    "  seq      integer NOT NULL DEFAULT 0," +
    "  flags    text" +
    ")");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS proof_block_stores_uniq ON proof_block_stores (block_id, store_id, pull)");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_block_stores_seq_idx ON proof_block_stores (block_id, seq)");

  return { migration: "003_ops", tables: made };
}

async function migrateCatalog(pool) {
  const made = [];
  async function t(name, sql) { await pool.query(sql); made.push(name); }

  await t("proof_products",
    "CREATE TABLE IF NOT EXISTS proof_products (" +
    "  branch_id  text NOT NULL REFERENCES branches(id)," +
    "  id         text NOT NULL," +
    "  item_no    text," +
    "  name       text NOT NULL," +
    "  brand      text," +
    "  pack       text," +
    "  active     boolean NOT NULL DEFAULT true," +
    "  created_at timestamptz NOT NULL DEFAULT now()," +
    "  PRIMARY KEY (branch_id, id)" +
    ")");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_products_name_idx ON proof_products (branch_id, lower(name))");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_products_item_no_idx ON proof_products (branch_id, item_no) WHERE item_no IS NOT NULL");

  // The named unit of photo capture and time measurement -- "Cooler", "Beer
  // Cave", "Aisle 4 Endcap". New: the shipped merch_store_map screen only had
  // raw aisle text, no capture unit to open/close a visit timer against.
  await t("proof_sections",
    "CREATE TABLE IF NOT EXISTS proof_sections (" +
    "  id         bigserial PRIMARY KEY," +
    "  branch_id  text NOT NULL REFERENCES branches(id)," +
    "  store_id   text NOT NULL," +
    "  label      text NOT NULL," +
    "  ord        integer NOT NULL DEFAULT 0," +
    "  active     boolean NOT NULL DEFAULT true" +
    ")");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_sections_store_idx ON proof_sections (branch_id, store_id) WHERE active");

  await t("proof_plan_items",
    "CREATE TABLE IF NOT EXISTS proof_plan_items (" +
    "  id          bigserial PRIMARY KEY," +
    "  branch_id   text NOT NULL REFERENCES branches(id)," +
    "  store_id    text NOT NULL," +
    "  section_id  bigint REFERENCES proof_sections(id) ON DELETE SET NULL," +
    "  product_id  text NOT NULL," +
    "  aisle       text," + // deliberately TEXT -- "End of 33", "Left Wall"
    "  bay         text," +
    "  shelf       text," +
    "  note        text," +
    "  seq         integer NOT NULL DEFAULT 0," +
    "  active      boolean NOT NULL DEFAULT true," +
    "  updated_at  timestamptz NOT NULL DEFAULT now()" +
    ")");
  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS proof_plan_items_uniq ON proof_plan_items " +
    "(branch_id, store_id, product_id, COALESCE(aisle,''), COALESCE(bay,''), COALESCE(shelf,''))"
  );
  await pool.query("CREATE INDEX IF NOT EXISTS proof_plan_items_store_idx ON proof_plan_items (branch_id, store_id) WHERE active");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_plan_items_section_idx ON proof_plan_items (section_id) WHERE active");

  return { migration: "004_catalog", tables: made };
}

async function migrateVisits(pool) {
  const made = [];
  async function t(name, sql) { await pool.query(sql); made.push(name); }

  await t("proof_visits",
    "CREATE TABLE IF NOT EXISTS proof_visits (" +
    "  id               bigserial PRIMARY KEY," +
    "  branch_id        text NOT NULL REFERENCES branches(id)," +
    "  merch_id         text NOT NULL REFERENCES proof_people(id)," +
    "  store_id         text NOT NULL," +
    "  block_id         bigint REFERENCES proof_week_blocks(id)," +
    "  started_at       timestamptz NOT NULL DEFAULT now()," +
    "  ended_at         timestamptz," +
    "  effective_end_at timestamptz," +
    "  close_reason     text CHECK (close_reason IN ('manual','forgotten','next_visit','nightly'))," +
    "  lat              double precision," +
    "  lng              double precision," +
    "  accuracy_m       double precision," +
    "  geo_flag         boolean NOT NULL DEFAULT false," +
    "  geo_denied       boolean NOT NULL DEFAULT false," +
    "  device_id        text," +
    "  submitted_at     timestamptz" +
    ")");
  // The one-open-visit rule, enforced by Postgres -- not just app code.
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS proof_visits_one_open ON proof_visits (merch_id) WHERE ended_at IS NULL");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_visits_merch_idx ON proof_visits (merch_id, started_at)");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_visits_store_idx ON proof_visits (branch_id, store_id, started_at)");

  await t("proof_visit_events",
    "CREATE TABLE IF NOT EXISTS proof_visit_events (" +
    "  id         bigserial PRIMARY KEY," +
    "  visit_id   bigint NOT NULL REFERENCES proof_visits(id) ON DELETE CASCADE," +
    "  kind       text NOT NULL CHECK (kind IN ('visit_start','section_enter','section_exit','visit_end'))," +
    "  section_id bigint," +
    "  at_client  timestamptz," +
    "  at_server  timestamptz NOT NULL DEFAULT now()," +
    "  seq        integer NOT NULL DEFAULT 0" +
    ")");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_visit_events_visit_idx ON proof_visit_events (visit_id, seq)");

  await t("proof_item_results",
    "CREATE TABLE IF NOT EXISTS proof_item_results (" +
    "  id            bigserial PRIMARY KEY," +
    "  visit_id      bigint NOT NULL REFERENCES proof_visits(id) ON DELETE CASCADE," +
    "  plan_item_id  bigint REFERENCES proof_plan_items(id)," +
    "  status        text NOT NULL CHECK (status IN ('stocked','out_of_stock','not_carried','fixed'))," +
    "  note          text," +
    "  created_at    timestamptz NOT NULL DEFAULT now()" +
    ")");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_item_results_visit_idx ON proof_item_results (visit_id)");

  await t("proof_photos",
    "CREATE TABLE IF NOT EXISTS proof_photos (" +
    "  id           bigserial PRIMARY KEY," +
    "  visit_id     bigint NOT NULL REFERENCES proof_visits(id) ON DELETE CASCADE," +
    "  section_id   bigint," +
    "  mime         text," +
    "  bytes        text NOT NULL," + // base64 data URL, same convention as photo:ph_* rows
    "  byte_len     integer," +
    "  taken_at     timestamptz NOT NULL DEFAULT now()," +
    "  archived_at  timestamptz," + // reserved for the phase-5 OneDrive archive
    "  archive_path text," +
    "  purged_at    timestamptz" +
    ")");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_photos_visit_idx ON proof_photos (visit_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_photos_archive_idx ON proof_photos (archived_at) WHERE purged_at IS NULL");

  return { migration: "005_visits", tables: made };
}

async function migratePoints(pool) {
  const made = [];
  async function t(name, sql) { await pool.query(sql); made.push(name); }

  await t("proof_points",
    "CREATE TABLE IF NOT EXISTS proof_points (" +
    "  id         bigserial PRIMARY KEY," +
    "  branch_id  text NOT NULL REFERENCES branches(id)," +
    "  merch_id   text NOT NULL REFERENCES proof_people(id)," +
    "  period_key text NOT NULL," + // YYYY-MM, canonical form -- labels never reach tables
    "  visit_id   bigint REFERENCES proof_visits(id)," +
    "  points     integer NOT NULL," +
    "  reason     text," +
    "  at         timestamptz NOT NULL DEFAULT now()" +
    ")");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_points_leaderboard_idx ON proof_points (branch_id, period_key, merch_id)");

  return { migration: "006_points", tables: made };
}

/* Category (beer / non-alc / whatever comes next) on the product, and on the
 * visit. Deliberately NO CHECK constraint on either: the set of categories a
 * branch cares about is data, not schema, and a new one should never need a
 * migration. The API validates against PRODUCT_CATEGORIES instead.
 *
 * One category PER VISIT, not a switch mid-visit. Working beer and then NA at
 * one store is two visits, which the app already supports (a second visit at
 * the same store is normal) and which keeps "how long did beer take" a
 * measured number rather than an apportioned one.
 */
async function migrateCategories(pool) {
  const added = [];
  async function col(table, name, ddl) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${name} ${ddl}`);
    added.push(table + "." + name);
  }
  await col("proof_products", "category", "text");
  await col("proof_visits", "category", "text");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_products_category_idx ON proof_products (branch_id, category) WHERE active");
  await pool.query("CREATE INDEX IF NOT EXISTS proof_visits_category_idx ON proof_visits (branch_id, category, started_at)");
  return { migration: "007_categories", columns: added };
}

module.exports = { migrateIdentity, migrateOps, migrateCatalog, migrateVisits, migratePoints, migrateCategories };
