"use strict";
/* lib/test-db.js -- batchUpsert against a fake pool. No database.
   The three things that make a bulk import survive a real export: it chunks
   under Postgres's parameter ceiling, it collapses duplicate conflict keys
   (two in one statement is a hard error), and it writes one statement per
   chunk rather than one per row. */
const assert = require("assert");
const { batchUpsert } = require("./db");

let n = 0, failed = 0;
function t(name, fn) { n++; return fn().catch((e) => { failed++; console.error("FAIL:", name, "--", e.message); }); }
function fakePool() { const calls = []; return { calls, query: async (sql, params) => { calls.push({ sql, n: params.length }); return { rowCount: 0 }; } }; }

(async () => {
  await t("collapses rows sharing a conflict key, last one wins", async () => {
    const p = fakePool();
    const r = await batchUpsert(p, { table: "t", columns: ["a", "b", "c"], conflict: ["a", "b"], rows: [[1, 2, "x"], [1, 2, "y"], [3, 4, "z"]] });
    assert.strictEqual(r.written, 2);
    assert.strictEqual(r.collapsed, 1);
    assert.ok(p.calls[0].sql.includes("ON CONFLICT (a,b) DO UPDATE SET c = EXCLUDED.c"));
    assert.strictEqual(p.calls[0].n, 6, "two rows x three columns");
  });

  await t("one statement per chunk, never one per row", async () => {
    const p = fakePool();
    const cols = Array.from({ length: 12 }, (_, i) => "c" + i);
    const rows = Array.from({ length: 12000 }, (_, i) => cols.map((_, j) => (j === 0 ? i : "v")));
    const r = await batchUpsert(p, { table: "t", columns: cols, conflict: ["c0"], rows });
    assert.strictEqual(r.written, 12000);
    assert.strictEqual(p.calls.length, 3, "12k rows of 12 columns = 3 chunks, not 12000 round trips");
  });

  await t("never exceeds Postgres's parameter ceiling", async () => {
    const p = fakePool();
    const cols = Array.from({ length: 9 }, (_, i) => "c" + i);
    const rows = Array.from({ length: 40000 }, (_, i) => cols.map((_, j) => (j === 0 ? i : "v")));
    await batchUpsert(p, { table: "t", columns: cols, conflict: ["c0"], rows });
    assert.ok(p.calls.every((c) => c.n < 65535), "every statement under 65535 parameters");
  });

  await t("an explicit update list wins over updating every column", async () => {
    const p = fakePool();
    await batchUpsert(p, { table: "t", columns: ["a", "b", "c"], conflict: ["a"], rows: [[1, 2, 3]], update: ["c"] });
    assert.ok(p.calls[0].sql.includes("DO UPDATE SET c = EXCLUDED.c"));
    assert.ok(!p.calls[0].sql.includes("b = EXCLUDED.b"));
  });

  await t("doNothing skips a conflict target and counts only what landed", async () => {
    const p = fakePool();
    p.query = async (sql, params) => { p.calls.push({ sql, n: params.length }); return { rowCount: 2 }; };
    const r = await batchUpsert(p, { table: "proof_plan_items", columns: ["a", "b", "c"], doNothing: true, rows: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] });
    assert.ok(p.calls[0].sql.includes("ON CONFLICT DO NOTHING"));
    assert.ok(!p.calls[0].sql.includes("DO UPDATE"));
    // rowCount, not slice length: rows the database skipped must not be
    // reported back to someone as "added".
    assert.strictEqual(r.written, 2);
  });

  await t("no rows issues no statement at all", async () => {
    const p = fakePool();
    const r = await batchUpsert(p, { table: "t", columns: ["a"], conflict: ["a"], rows: [] });
    assert.deepStrictEqual(r, { written: 0, collapsed: 0 });
    assert.strictEqual(p.calls.length, 0);
  });

  console.log((n - failed) + "/" + n + " passed");
  if (failed) process.exit(1);
})();
