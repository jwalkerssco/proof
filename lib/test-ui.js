"use strict";
/* lib/test-ui.js -- server-renders every screen's initial state with realistic
   data. Catches reference errors and bad props that node --check and the
   bundler cannot. useEffect does not run under SSR, so nothing fetches.
   Run: node lib/test-ui.js  (needs node_modules; part of `npm test`) */
const path = require("path");
const esbuild = require("esbuild");
const React = require("react");
const { renderToString } = require("react-dom/server");

const built = esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "public", "proof-ui.jsx")],
  bundle: true, write: false, format: "cjs", platform: "node", jsx: "automatic",
  external: ["react", "react-dom", "react/jsx-runtime"], logLevel: "silent",
});
const mod = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(mod, mod.exports, require);
const S = mod.exports;

const ui = { HEAD: "H", BODY: "B", H: () => ({}), icons: {}, C: {}, brand: {} };
const boot = {
  me: { id: "pf-jess", name: "Jess Walker", role: "merch" }, date: "2026-09-20",
  myDay: { date: "2026-09-20", weekday: 6, blocks: [{ id: 1, startTime: "04:30", truck: true, note: null, teamIds: ["team-c"], members: [], stores: [{ id: 11, storeId: "kk206", storeName: "Kent Kwik #206", pull: 1, seq: 1, mapped: 3 }, { id: 12, storeId: "kk206", storeName: "Kent Kwik #206", pull: 2, seq: 2, mapped: 3 }, { id: 13, storeId: "x", storeName: "No Map Store", pull: 1, seq: 3, mapped: 0 }] }] },
  tomorrow: { date: "2026-09-21", weekday: 0, blocks: [{ id: 2, startTime: "08:00", truck: false, teamIds: [], members: [{ id: "pf-jess", name: "Jess" }], stores: [] }] },
};
let n = 0, failed = 0;
function t(name, el) {
  n++;
  try { const html = renderToString(el); if (!html || html.length < 20) throw new Error("empty render"); }
  catch (e) { failed++; console.error("FAIL", name, "--", e.message); }
}
const h = React.createElement;
t("App merch home", h(S.App, { ui, boot, role: "proof", onLogout() {}, onRefresh() {} }));
t("App admin", h(S.App, { ui, boot: { me: { name: "Admin" } }, role: "proofadmin", onLogout() {} }));
t("TodayList done/open/unmapped", h(S.TodayList, { ui, boot, mine: [{ storeId: "kk206", endedAt: "2026-09-20T10:00:00Z", closeReason: "manual", items: 4, photos: 2 }], openVisit: { visit: { storeId: "x", startedAt: "2026-09-20T09:00:00Z" }, storeName: "No Map Store" }, onOpen() {} }));
t("TodayList empty", h(S.TodayList, { ui, boot: { me: { name: "A" }, myDay: { blocks: [] } }, mine: [], openVisit: null, onOpen() {} }));
t("StoreFlow pre-visit loading", h(S.StoreFlow, { ui, storeId: "kk206", storeName: "Kent Kwik #206", openVisit: null, notify() {}, onExit() {}, onFinished() {} }));
t("StoreFlow blocked elsewhere", h(S.StoreFlow, { ui, storeId: "kk206", openVisit: { visit: { id: 9, storeId: "other", startedAt: "2026-09-20T09:00:00Z" }, storeName: "Elsewhere" }, notify() {}, onExit() {}, onFinished() {} }));
t("DoneScreen", h(S.DoneScreen, { ui, summary: { items: 12, photos: 3, points: 13, minutes: 22 }, storeName: "Kent Kwik #206", onHome() {} }));
t("DoneScreen no summary", h(S.DoneScreen, { ui, summary: null, onHome() {} }));
t("Leaderboard loading", h(S.LeaderboardScreen, { ui, me: boot.me }));
t("ScheduleBoard loading", h(S.ScheduleBoard, { ui, notify() {} }));
t("BlockStores", h(S.BlockStores, { ui, notify() {}, onChange() {}, block: { id: 1, stores: [{ id: 1, storeId: "a", storeName: "A", pull: 1, mapped: 0 }, { id: 2, storeId: "a", storeName: "A", pull: 2, mapped: 2 }] } }));
t("StoresPanel", h(S.StoresPanel, { ui, notify() {} }));
t("CatalogPanel", h(S.CatalogPanel, { ui, notify() {} }));
t("TeamPanel", h(S.TeamPanel, { ui, notify() {} }));
t("DevicesPanel", h(S.DevicesPanel, { ui, notify() {} }));
t("LivePanel", h(S.LivePanel, { ui }));
t("VisitDetail loading", h(S.VisitDetail, { ui, visitId: 1, onClose() {} }));
t("ReportingPanel", h(S.ReportingPanel, { ui }));
t("Sheet", h(S.Sheet, { ui, title: "x", body: "y", onConfirm() {}, onCancel() {} }));
t("Chip", h(S.Chip, { label: "Team A", color: "#000", onRemove() {} }));
console.log((n - failed) + "/" + n + " screens rendered");
if (failed) process.exit(1);
