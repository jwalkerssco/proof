"use strict";
/* proof/test-proof.js -- pure-function tests, no DB, no network. Mirrors the
 * test-tagup.js / test-chains.js convention: run with `node proof/test-proof.js`
 * from artifacts/gameday. Covers the load-bearing mechanics called out in the
 * build plan: the truck-day start-time default, product id derivation, the
 * myDay team/member filter, and the store/product paste-import header maps.
 */
const assert = require("assert");
const P = require("./index");

let n = 0, failed = 0;
function t(name, fn) {
  n++;
  try { fn(); } catch (e) { failed++; console.error("FAIL:", name, "--", e.message); }
}

/* ---- resolveBlockStart: the truck-day default rule ---- */
t("no truck/startTime change keeps the current start", () => {
  assert.strictEqual(P.resolveBlockStart({ startTime: "09:15", truck: false }, {}), "09:15");
});
t("flipping truck ON with no explicit start defaults to 04:30", () => {
  assert.strictEqual(P.resolveBlockStart({ startTime: "08:00", truck: false }, { truck: true }), P.TRUCK_START);
});
t("flipping truck OFF with no explicit start defaults to 08:00", () => {
  assert.strictEqual(P.resolveBlockStart({ startTime: "04:30", truck: true }, { truck: false }), P.DEFAULT_START);
});
t("an explicit startTime always wins over the truck default", () => {
  assert.strictEqual(P.resolveBlockStart({ startTime: "08:00", truck: false }, { truck: true, startTime: "05:00" }), "05:00");
});
t("setting truck to its CURRENT value changes nothing", () => {
  assert.strictEqual(P.resolveBlockStart({ startTime: "09:00", truck: true }, { truck: true }), "09:00");
});
t("startTime alone (no truck change) is honored verbatim", () => {
  assert.strictEqual(P.resolveBlockStart({ startTime: "08:00", truck: false }, { startTime: "10:30" }), "10:30");
});

/* ---- deriveProductId: item number wins over name slug ---- */
t("product id prefers the item number over the name", () => {
  assert.strictEqual(P.deriveProductId({ name: "Bud Light 1x18 12oz Can", itemNo: "18018" }), "no-18018");
});
t("product id falls back to a name slug with no item number", () => {
  assert.strictEqual(P.deriveProductId({ name: "Bud Light 1x18 12oz Can" }), "bud-light-1x18-12oz-can");
});
t("an explicit id always wins (renaming keeps the id stable)", () => {
  assert.strictEqual(P.deriveProductId({ id: "no-18018", name: "Bud Light Renamed", itemNo: "18018" }), "no-18018");
});

/* ---- dayBlocksFor: the myDay filter (team OR individually-added member) ---- */
const BLOCKS = [
  { id: 1, teamIds: ["team-a"], members: [] },
  { id: 2, teamIds: ["team-b"], members: [{ id: "pf-jess", name: "Jess" }] },
  { id: 3, teamIds: [], members: [{ id: "pf-sam", name: "Sam" }] },
];
t("a person on the block's team is included", () => {
  const out = P.dayBlocksFor(BLOCKS, "team-a", "pf-nobody");
  assert.deepStrictEqual(out.map((b) => b.id), [1]);
});
t("a person added individually is included even off-team", () => {
  const out = P.dayBlocksFor(BLOCKS, "team-z", "pf-sam");
  assert.deepStrictEqual(out.map((b) => b.id), [3]);
});
t("both team AND individual membership can select the same day", () => {
  const out = P.dayBlocksFor(BLOCKS, "team-b", "pf-sam");
  assert.deepStrictEqual(out.map((b) => b.id).sort(), [2, 3]);
});
t("no team and not added individually selects nothing", () => {
  assert.deepStrictEqual(P.dayBlocksFor(BLOCKS, null, "pf-nobody"), []);
});
t("dayBlocksFor tolerates an empty/undefined day", () => {
  assert.deepStrictEqual(P.dayBlocksFor(undefined, "team-a", "pf-x"), []);
});

/* ---- sectionSpans: how long was spent in each section ---- */
const T0 = Date.parse("2026-09-21T10:00:00Z");
const ev = (kind, sectionId, mins, seq) => ({ kind, section_id: sectionId, section_label: sectionId ? "S" + sectionId : "", at_server: new Date(T0 + mins * 60000).toISOString(), seq });

t("pairs an enter with its exit", () => {
  const s = P.sectionSpans([ev("visit_start", null, 0, 0), ev("section_enter", 1, 1, 1), ev("section_exit", 1, 7, 2)]);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].seconds, 360);
});
t("visit_end closes a section still open", () => {
  const s = P.sectionSpans([ev("section_enter", 2, 8, 0), ev("visit_end", null, 12, 1)]);
  assert.strictEqual(s[0].seconds, 240);
});
t("entering a new section closes the previous one", () => {
  const s = P.sectionSpans([ev("section_enter", 1, 0, 0), ev("section_enter", 2, 3, 1)]);
  assert.strictEqual(s.find((x) => String(x.sectionId) === "1").seconds, 180);
});
t("two passes through one section sum, and count as passes", () => {
  const s = P.sectionSpans([ev("section_enter", 1, 0, 0), ev("section_exit", 1, 2, 1), ev("section_enter", 1, 5, 2), ev("section_exit", 1, 8, 3)]);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].seconds, 300);
  assert.strictEqual(s[0].visits, 2);
});
t("an unclosed section reports null, never a guessed duration", () => {
  assert.strictEqual(P.sectionSpans([ev("section_enter", 3, 0, 0)])[0].seconds, null);
});
t("no events is no spans, not a crash", () => {
  assert.deepStrictEqual(P.sectionSpans([]), []);
  assert.deepStrictEqual(P.sectionSpans(undefined), []);
});

/* ---- colMap / prodColMap: header synonym matching ---- */
t("store header map finds name/addr/route by synonym, case-insensitive", () => {
  const m = P.colMap(["Name", "Address", "City", "State", "Zip", "Route"]);
  assert.strictEqual(m.name, 0); assert.strictEqual(m.addr, 1); assert.strictEqual(m.route, 5);
});
t("store header map is undefined for a column that isn't present", () => {
  const m = P.colMap(["Name", "City"]);
  assert.strictEqual(m.route, undefined);
});
t("product header map resolves Item # synonyms", () => {
  const m = P.prodColMap(["Name", "Item #", "Brand"]);
  assert.strictEqual(m.itemNo, 1);
});
t("looksLikeHeader is false for a mostly-numeric first row (no header)", () => {
  assert.strictEqual(P.looksLikeHeader(["18018", "53011"]), false);
});
t("looksLikeHeader is true for a real header row", () => {
  assert.strictEqual(P.looksLikeHeader(["Name", "Item #"]), true);
});

/* ---- slug ---- */
t("slug lowercases and strips punctuation", () => {
  assert.strictEqual(P.slug("Bud Light 1x18 12oz Can!"), "bud-light-1x18-12oz-can");
});

/* ---- VIP's Comparison export: the catalog Odessa actually has ----
   Headers are Brands | Item Names | Item Name ID | Product Classes, and not
   one of them matched the original synonym lists. The measured file is 920
   rows / 621 brands / classes Beer 398, Non-Alcohol 466, Wine 54. */
const VIP_HEADER = ["Brands", "Item Names", "Item Name ID", "Product Classes", ""];
t("the VIP Comparison header maps all four columns", () => {
  const m = P.prodColMap(VIP_HEADER);
  assert.strictEqual(m.brand, 0, "brand");
  assert.strictEqual(m.name, 1, "name");
  assert.strictEqual(m.itemNo, 2, "itemNo");
  assert.strictEqual(m.category, 3, "category");
});
t("'Item Name ID' is the item number, never the product name", () => {
  // The synonym match must stay EXACT. A prefix/contains test would let
  // "item name" claim the "Item Name ID" column and import ids as names.
  const m = P.prodColMap(["Item Name ID", "Item Names"]);
  assert.strictEqual(m.itemNo, 0);
  assert.strictEqual(m.name, 1);
});
t("a header with only Brands and Item Names still maps", () => {
  const m = P.prodColMap(["Brands", "Item Names"]);
  assert.strictEqual(m.brand, 0); assert.strictEqual(m.name, 1);
  assert.strictEqual(m.category, undefined);
});
t("normCategory reads VIP's own class spellings", () => {
  assert.strictEqual(P.normCategory("Beer"), "beer");
  assert.strictEqual(P.normCategory("Non-Alcohol"), "na");
  assert.strictEqual(P.normCategory("Wine"), "wine");
});
t("Wine is its own category, not folded into either of the others", () => {
  // 54 of 920 rows. Folding it into beer or NA is wrong in both directions;
  // leaving it null drops it out of the time split without saying so.
  assert.ok(P.PRODUCT_CATEGORIES.some((c) => c.id === "wine"));
  assert.strictEqual(P.validCategory("wine"), "wine");
  assert.strictEqual(P.categoryLabel("wine"), "Wine");
});
t("an unknown class stays null rather than being guessed", () => {
  assert.strictEqual(P.normCategory("Novelty"), null);
  assert.strictEqual(P.normCategory(""), null);
  assert.strictEqual(P.normCategory(null), null);
});

/* ---- the export's own age ---- */
t("the VIP trailer row yields the creation date", () => {
  assert.strictEqual(P.exportCreatedOn([["Report Created on 9/24/2026 11:16:57 AM", "", "", "", ""]]), "2026-09-24");
});
t("the date is read M/D/YYYY, not D/M", () => {
  // 3/9 is March 9th. Reading it as September 3rd moves every export before
  // the 13th into another month and inverts any staleness verdict.
  assert.strictEqual(P.exportCreatedOn([["Report Created on 3/9/2026 8:00:00 AM"]]), "2026-03-09");
});
t("a file that says nothing about itself yields null, never a guess", () => {
  assert.strictEqual(P.exportCreatedOn([["Michelob Ultra", "Ultra 1x30 12oz Can", "18030", "Beer"]]), null);
  assert.strictEqual(P.exportCreatedOn([]), null);
  assert.strictEqual(P.exportCreatedOn(null), null);
});
t("age is a calendar-day difference, never elapsed hours", () => {
  // The stamp carries no timezone. An hours-based age reads 5 on a Central
  // laptop and 6 on a UTC server, so a test of it passes locally and fails
  // in production.
  assert.strictEqual(P.exportAgeDays("2026-09-24", "2026-09-24"), 0);
  assert.strictEqual(P.exportAgeDays("2026-09-24", "2026-10-01"), 7);
  assert.strictEqual(P.exportAgeDays(null, "2026-10-01"), null);
});

/* ---- role fence (proof/roles.js) ---- */
const R = require("./roles");
t("proofPathOk accepts /api/proof/*, /api/bootstrap, /api/logout", () => {
  assert.ok(R.proofPathOk("/api/proof/week"));
  assert.ok(R.proofPathOk("/api/bootstrap"));
  assert.ok(R.proofPathOk("/api/logout"));
});
t("proofPathOk rejects everything else, including a bare /proof/ prefix path", () => {
  assert.ok(!R.proofPathOk("/api/pfp"));
  assert.ok(!R.proofPathOk("/proof/week")); // must be under /api/, not just contain "proof/"
  assert.ok(!R.proofPathOk("/api/merch/week"));
});
t("isProofRole recognizes both session roles and nothing else", () => {
  assert.ok(R.isProofRole("proof")); assert.ok(R.isProofRole("proofadmin"));
  assert.ok(!R.isProofRole("merch")); assert.ok(!R.isProofRole("admin"));
});

console.log(n - failed + "/" + n + " passed");
if (failed) process.exit(1);
