"use strict";
/* proof/test-blocks.js -- the schedule-block writes, called EXACTLY the way
 * server.js calls them, against a fake pool. No database.
 *
 * This file exists because of a real bug: blockStoreAdd was declared
 * (branch, blockId, storeId, flags) while the route called it
 * (blockId, storeId, flags). Every argument shifted one slot, the store id
 * went into a bigint column, and every "add store" 503'd -- silently, because
 * the client ignored the error. Unit-testing the function on its own
 * signature would have passed. Calling it the way the route does is what
 * catches it, so these tests mirror server.js argument-for-argument.
 */
const assert = require("assert");
const PROOF_MOD = require("./index");

let n = 0, failed = 0;
function t(name, fn) { n++; return Promise.resolve().then(fn).catch((e) => { failed++; console.error("FAIL:", name, "--", e.message); }); }

// Returns canned rows per query, and records every call.
function fakePool(answers) {
  const calls = [];
  let i = 0;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params: params || [] });
      const a = answers && answers[i++];
      return a || { rows: [{ n: 1 }], rowCount: 1 };
    },
  };
}
function mod(pool) {
  return PROOF_MOD.create({
    getPool: () => pool, BRANCHES: { odessa: { label: "Odessa" } }, SESSION_MS: 1000,
    hashPin: (p) => "s2:x:" + p, verifyPin: () => true, makeToken: () => "tok",
    _sessionEstablish: async () => {}, revokeSessionsFor: async () => 0, batchUpsert: async () => ({ written: 0, collapsed: 0 }),
  });
}

(async () => {
  await t("blockStoreAdd puts the BLOCK id in block_id and the STORE id in store_id", async () => {
    const pool = fakePool([{ rows: [{ n: 1 }] }, { rows: [{ n: 4 }] }, { rows: [] }]);
    // Exactly how server.js calls it: (blockId, storeId, flags)
    const out = await mod(pool).blockStoreAdd(12, "allsups-102266-3", null);
    const insert = pool.calls.find((c) => c.sql.startsWith("INSERT INTO proof_block_stores"));
    assert.ok(insert, "an insert was issued");
    assert.strictEqual(insert.params[0], 12, "block_id is the numeric block id");
    assert.strictEqual(insert.params[1], "allsups-102266-3", "store_id is the store id");
    assert.strictEqual(out.pull, 1);
  });

  await t("a store added twice to one block becomes pull 2", async () => {
    const pool = fakePool([{ rows: [{ n: 2 }] }, { rows: [{ n: 9 }] }, { rows: [] }]);
    const out = await mod(pool).blockStoreAdd(12, "heb-382-1", null);
    assert.strictEqual(out.pull, 2, "MAX(pull)+1 is what gets stored and reported");
    const insert = pool.calls.find((c) => c.sql.startsWith("INSERT INTO proof_block_stores"));
    assert.strictEqual(insert.params[2], 2);
  });

  await t("no block-store query ever receives a store id where a block id belongs", async () => {
    const pool = fakePool([{ rows: [{ n: 1 }] }, { rows: [{ n: 1 }] }, { rows: [] }]);
    await mod(pool).blockStoreAdd(7, "some-store-id", null);
    for (const c of pool.calls) {
      const i = c.sql.indexOf("block_id=$");
      if (i === -1) continue;
      const pos = Number(c.sql.slice(i + 10, i + 11)) - 1;
      assert.strictEqual(typeof c.params[pos], "number", "block_id parameter is numeric in: " + c.sql);
    }
  });

  await t("blockStoreRemove without a rowId peels the HIGHEST pull, not the first", async () => {
    const pool = fakePool([{ rows: [] }]);
    await mod(pool).blockStoreRemove(12, "heb-382-1");
    const del = pool.calls[0];
    assert.ok(/ORDER BY pull DESC LIMIT 1/.test(del.sql), del.sql);
    assert.strictEqual(del.params[0], 12);
    assert.strictEqual(del.params[1], "heb-382-1");
  });

  await t("blockStoreRemove with a rowId deletes that exact row", async () => {
    const pool = fakePool([{ rows: [] }]);
    await mod(pool).blockStoreRemove(12, "heb-382-1", 88);
    assert.ok(pool.calls[0].sql.includes("WHERE id=$1"));
    assert.strictEqual(pool.calls[0].params[0], 88);
  });

  await t("blockMemberAdd takes (blockId, personId, addedBy) in that order", async () => {
    const pool = fakePool([{ rows: [] }]);
    await mod(pool).blockMemberAdd(12, "pf-jed-ab12", "pf-admin");
    assert.deepStrictEqual(pool.calls[0].params, [12, "pf-jed-ab12", "pf-admin"]);
  });

  await t("blockMemberRemove takes (blockId, personId)", async () => {
    const pool = fakePool([{ rows: [] }]);
    await mod(pool).blockMemberRemove(12, "pf-jed-ab12");
    assert.deepStrictEqual(pool.calls[0].params, [12, "pf-jed-ab12"]);
  });

  await t("blockStoreFlags takes (rowId, flags)", async () => {
    const pool = fakePool([{ rows: [] }]);
    await mod(pool).blockStoreFlags(88, "Rotate");
    assert.deepStrictEqual(pool.calls[0].params, [88, "Rotate"]);
  });

  console.log((n - failed) + "/" + n + " passed");
  if (failed) process.exit(1);
})();
