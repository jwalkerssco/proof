"use strict";
/* lib/test-sheet.js -- the spreadsheet parser, no DB, no network.
   Builds real .xlsx and .csv buffers in memory and reads them back. */
const assert = require("assert");
const XLSX = require("xlsx");
const { parseWorkbook, parsePaste, findHeaderRow } = require("./sheet");

let n = 0, failed = 0;
function t(name, fn) { n++; try { fn(); } catch (e) { failed++; console.error("FAIL:", name, "--", e.message); } }

function xlsxBuf(rows, sheetName) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName || "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

t("reads a plain store sheet", () => {
  const r = parseWorkbook(xlsxBuf([["Name", "Address", "City", "State", "Zip", "Route"], ["Kent Kwik #206", "1200 N Grant", "Odessa", "TX", "79761", "21063"]]));
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[0][0], "Name");
  assert.strictEqual(r.rows[1][0], "Kent Kwik #206");
});
t("finds a header buried under a title block", () => {
  const r = parseWorkbook(xlsxBuf([["Store Master Export"], ["Generated 9/20/2026"], [], ["Name", "Address", "City", "State", "Zip", "Route"], ["Pecos Stop", "1 Main", "Pecos", "TX", "79772", "21080"]]));
  assert.strictEqual(r.rows[0][0], "Name", "header row should lead");
  assert.strictEqual(r.rows[1][0], "Pecos Stop");
});
t("keeps leading zeros on zip and route", () => {
  const r = parseWorkbook(xlsxBuf([["Name", "Zip", "Route"], ["A Store", "07104", "021063"]]));
  assert.strictEqual(r.rows[1][1], "07104");
  assert.strictEqual(r.rows[1][2], "021063");
});
t("drops fully blank rows", () => {
  const r = parseWorkbook(xlsxBuf([["Name", "City"], ["A", "Odessa"], ["", ""], ["B", "Midland"]]));
  assert.strictEqual(r.rows.length, 3);
});
t("reports the sheet it read", () => {
  const r = parseWorkbook(xlsxBuf([["Name", "City"], ["A", "Odessa"]], "Stores 2026"));
  assert.strictEqual(r.sheet, "Stores 2026");
});
t("an empty sheet is an error, not a crash", () => {
  assert.ok(parseWorkbook(xlsxBuf([[]])).error);
});
t("reads a CSV buffer through the same path", () => {
  const r = parseWorkbook(Buffer.from("Name,City,Route\nA Store,Odessa,21063\n", "utf8"));
  assert.strictEqual(r.rows[1][0], "A Store");
  assert.strictEqual(r.rows[1][2], "21063");
});
t("reads a product sheet's Item # header", () => {
  const r = parseWorkbook(xlsxBuf([["Name", "Item #", "Brand"], ["Bud Light 18pk", "18018", "Bud Light"]]));
  assert.strictEqual(r.rows[0][1], "Item #");
  assert.strictEqual(r.rows[1][1], "18018");
});
t("paste path splits on tabs", () => {
  const r = parsePaste("Name\tCity\nA Store\tOdessa");
  assert.deepStrictEqual(r.rows[1], ["A Store", "Odessa"]);
});
t("paste path falls back to commas", () => {
  const r = parsePaste("Name,City\nA Store,Odessa");
  assert.deepStrictEqual(r.rows[1], ["A Store", "Odessa"]);
});
t("paste with nothing in it is an error", () => { assert.ok(parsePaste("   ").error); });
t("findHeaderRow needs two known columns, not one", () => {
  assert.strictEqual(findHeaderRow([["Name"], ["Name", "City"]]), 1);
});
t("findHeaderRow falls back to row 0 when nothing is recognisable", () => {
  assert.strictEqual(findHeaderRow([["Foo", "Bar"], ["1", "2"]]), 0);
});

console.log((n - failed) + "/" + n + " passed");
if (failed) process.exit(1);
