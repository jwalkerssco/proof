"use strict";
/* lib/sheet.js -- turn an uploaded .xlsx / .xls / .csv into rows.
 *
 * Server-side on purpose: a real store list is hundreds of rows out of a
 * spreadsheet, and asking someone to paste that is how you get a mangled
 * import. Parsing here means one code path for both file and paste.
 *
 * Two things the parse has to survive, both learned from real exports:
 *
 * 1. THE HEADER IS NOT ALWAYS THE FIRST ROW. Exports carry title blocks,
 *    a date line, a blank row. So the header is FOUND -- the first row
 *    holding at least two known column names -- not assumed to be row 0.
 * 2. A NUMERIC CELL LOSES ITS LEADING ZEROS. Everything is read as text
 *    (`raw:false`), so a zip of 07104 or a route of 021063 survives.
 *
 * Only the first sheet is read. The sheet's name comes back in the result so
 * the screen can say which one it took -- "it read the wrong tab" is
 * otherwise invisible.
 */
const XLSX = require("xlsx");

// Every column either importer knows, so header detection works for both.
const KNOWN = [
  "name", "store", "account", "storename", "store name", "description", "product",
  "chain", "address", "addr", "street", "city", "state", "st", "zip", "zipcode", "postal",
  "route", "territory", "id", "storeid", "store#", "store #", "item no", "itemno",
  "item#", "item #", "sku", "brand", "pack", "package",
  // VIP's Comparison export pluralises every heading and calls the item
  // number "Item Name ID". None of the singular spellings above match it,
  // so without these the header row is missed and row 0 is read as data.
  "brands", "item names", "item name", "item name id", "item id",
  "product classes", "product class", "class of trade", "category",
];

function norm(v) { return String(v == null ? "" : v).trim().toLowerCase(); }

/* The first row with two or more known column names. Falls back to row 0 so a
   file with unusual headers still imports rather than refusing outright. */
function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 25); // a title block is never 25 rows deep
  for (let i = 0; i < limit; i++) {
    const hits = (rows[i] || []).filter((c) => KNOWN.indexOf(norm(c)) !== -1).length;
    if (hits >= 2) return i;
  }
  return 0;
}

/* Buffer -> { rows, sheet, sheets, headerRow, skipped }.
   `rows` starts AT the header row, which is the shape uploadStores and
   productsUpload already expect. */
function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const sheets = wb.SheetNames || [];
  if (!sheets.length) return { error: "That file has no sheets in it." };
  const ws = wb.Sheets[sheets[0]];
  const all = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", blankrows: false });
  const rows = all.filter((r) => (r || []).some((c) => String(c == null ? "" : c).trim() !== ""));
  if (!rows.length) return { error: "That sheet is empty." };
  const headerRow = findHeaderRow(rows);
  return { rows: rows.slice(headerRow), sheet: sheets[0], sheets, headerRow, skipped: all.length - rows.length };
}

/* The paste path, kept so both doors produce identical rows: tab-separated
   (what Excel puts on the clipboard), falling back to comma for a pasted CSV. */
function parsePaste(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { error: "Nothing pasted." };
  const sep = lines[0].indexOf("\t") !== -1 ? "\t" : ",";
  const rows = lines.map((l) => l.split(sep).map((c) => c.trim()));
  const headerRow = findHeaderRow(rows);
  return { rows: rows.slice(headerRow), sheet: "pasted", sheets: [], headerRow, skipped: 0 };
}

module.exports = { parseWorkbook, parsePaste, findHeaderRow, KNOWN };
