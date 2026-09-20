"use strict";
/* lib/test-auth.js -- the PIN primitives, no DB. Run: node lib/test-auth.js */
const assert = require("assert");
const { hashPin, verifyPin, makeToken } = require("./auth");

let n = 0, failed = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { failed++; console.error("FAIL:", name, "--", e.message); } }

t("hashPin produces the s2 form and verifies", () => {
  const h = hashPin("2468");
  assert.ok(/^s2:[0-9a-f]{32}:[0-9a-f]{64}$/.test(h));
  assert.strictEqual(verifyPin(h, "2468"), true);
});
t("a wrong PIN does not verify", () => { assert.strictEqual(verifyPin(hashPin("2468"), "2469"), false); });
t("two hashes of the same PIN differ (salted)", () => { assert.notStrictEqual(hashPin("1234"), hashPin("1234")); });
t("plaintext stored values are NEVER accepted", () => { assert.strictEqual(verifyPin("2468", "2468"), false); });
t("empty / null stored values do not verify", () => { assert.strictEqual(verifyPin("", "1"), false); assert.strictEqual(verifyPin(null, "1"), false); });
t("malformed stored values do not verify or throw", () => { assert.strictEqual(verifyPin("s2:zz", "1"), false); assert.strictEqual(verifyPin("s2:a:b:c", "1"), false); });
t("tokens are 48 hex chars and unique", () => { const a = makeToken(), b = makeToken(); assert.ok(/^[0-9a-f]{48}$/.test(a)); assert.notStrictEqual(a, b); });

console.log((n - failed) + "/" + n + " passed");
if (failed) process.exit(1);
