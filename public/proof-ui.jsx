/* public/proof-ui.jsx -- every Proof screen.
 *
 * Imported by public/app.jsx, which owns sign-in and the session and hands
 * fonts, the auth-header helper and icons in on the `ui` prop. The palette is
 * Proof's own (T below): navy on radiant white.
 *
 * Two audiences, one file:
 *   - a merchandiser's PHONE: Today -> Store -> Start Visit -> check items,
 *     photo each aisle -> End Visit (summary + points) -> Leaderboard.
 *     Section timing is INVISIBLE to them (design doc S3.4): it is fired
 *     from the first interaction in a section, never from a button.
 *   - a proofadmin's DESKTOP: Schedule board (drag teams AND individual
 *     people onto a block), Stores, Catalog & mapping, Team, Devices, Live,
 *     Reporting. Rendered `full` width by app.jsx's Shell; only a width
 *     changes across a breakpoint, never the tree.
 *
 * Every write reports back through a toast. Every list has an empty state.
 * Every destructive action confirms.
 */

import React, { useState, useEffect, useRef, useMemo } from "react";

/* ---------------- Proof's palette ---------------- */
const T = {
  navy: "#0E1F3C", navySoft: "#EEF1F6", ink: "#16243B", sub: "#5C6A80", mute: "#98A2B3",
  line: "#E4E7EC", bg: "#FFFFFF", panel: "#F7F8FA",
  green: "#1E9E5A", greenSoft: "#E6F6EC", red: "#C62828", redSoft: "#FCEBEA", amber: "#C98A00", amberSoft: "#FFF4D6",
};
const TEAM_HEX = { slate: "#64748B", navy: "#0E1F3C", gold: "#E0B23C", green: "#1E9E5A", rose: "#D6336C", teal: "#0F8B8D" };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // business week: Monday first

/* Every call FAILS SOFT into { error } -- never a thrown promise. A phone in
   a store drops its connection routinely, and an unhandled reject puts a red
   stack over the whole app instead of a message the person can act on. A
   non-JSON body (a proxy timeout page) lands here too. */
async function jfetch(url, init) {
  let r;
  try { r = await fetch(url, init); }
  catch (e) { return { error: "No connection — check your signal and try again.", offline: true }; }
  const text = await r.text().catch(() => "");
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch (e) {
    return { error: r.status === 413 ? "That file is too big." : "The server didn't finish that request. Try again.", status: r.status };
  }
  if (!r.ok && body && !body.error) body.error = "That didn't go through (" + r.status + ").";
  return body;
}
function jget(ui, url) { return jfetch(url, { headers: ui.H() }); }
function jpost(ui, url, body) { return jfetch(url, { method: "POST", headers: ui.H(), body: JSON.stringify(body || {}) }); }
// Multipart: the Content-Type header must be DROPPED so the browser can set
// its own boundary. Sending ui.H() as-is uploads a file the server can't read.
function jform(ui, url, fd) { const h = ui.H(); delete h["Content-Type"]; return jfetch(url, { method: "POST", headers: h, body: fd }); }
function Icon({ ui, name, size, color }) { const I = ui.icons && ui.icons[name]; return I ? React.createElement(I, { size: size || 18, color: color }) : null; }
function fmtTime(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
function fmtDay(ymd) { try { const [y, m, d] = String(ymd).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }); } catch (e) { return ymd; } }
function monthLabel(key) { try { const [y, m] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString([], { month: "long", year: "numeric", timeZone: "UTC" }); } catch (e) { return key; } }
function fmtStart(hhmm) { const [h, m] = String(hhmm || "").split(":").map(Number); if (isNaN(h)) return hhmm; const ap = h >= 12 ? "PM" : "AM"; return ((h % 12) || 12) + ":" + String(m || 0).padStart(2, "0") + " " + ap; }

/* ---------------- photo compression (self-contained) ---------------- */
function compressPhoto(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("couldn't read photo"));
    reader.onload = () => {
      img.onerror = () => reject(new Error("couldn't decode photo"));
      img.onload = () => {
        const scale = Math.min(1, (maxDim || 1200) / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve({ dataUrl: c.toDataURL("image/jpeg", quality || 0.75), mime: "image/jpeg" });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
// Stamp-and-flag, never block (design doc S1.5). Short timeout: nobody waits
// on a GPS fix inside a metal-roofed store.
function getGeo() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ geoDenied: true });
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => resolve({ geoDenied: true }),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 }
    );
  });
}

/* ---------------- primitives ---------------- */
function Card({ children, style, accent, pad }) {
  return <div style={Object.assign({ background: T.bg, border: `1px solid ${T.line}`, borderLeft: accent ? `4px solid ${accent}` : `1px solid ${T.line}`, borderRadius: 14, padding: pad == null ? 16 : pad, marginBottom: 12, boxShadow: "0 1px 2px rgba(16,31,60,0.04)" }, style || {})}>{children}</div>;
}
function Btn({ ui, kind, small, block, disabled, onClick, children, style, icon }) {
  const base = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, padding: small ? "8px 14px" : "13px 20px", borderRadius: 11, fontFamily: ui.HEAD, fontWeight: 600, fontSize: small ? 13 : 15, cursor: disabled ? "default" : "pointer", border: "1px solid transparent", opacity: disabled ? 0.5 : 1, width: block ? "100%" : undefined, lineHeight: 1.2, whiteSpace: "nowrap" };
  const skins = {
    primary: { background: T.navy, color: "#fff" },
    green: { background: T.green, color: "#fff" },
    ghost: { background: "#fff", color: T.navy, borderColor: T.line },
    subtle: { background: T.navySoft, color: T.navy },
    danger: { background: "#fff", color: T.red, borderColor: T.red },
  };
  return <button disabled={disabled} onClick={onClick} style={Object.assign({}, base, skins[kind || "primary"], style || {})}>{icon && <Icon ui={ui} name={icon} size={small ? 14 : 17} color={(skins[kind || "primary"]).color} />}{children}</button>;
}
function Badge({ children, tone }) {
  const tones = { green: [T.greenSoft, T.green], red: [T.redSoft, T.red], amber: [T.amberSoft, T.amber], navy: [T.navySoft, T.navy], gray: [T.panel, T.sub] };
  const [bg, fg] = tones[tone || "gray"];
  return <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, background: bg, color: fg, fontSize: 11, fontWeight: 700, letterSpacing: 0.3, whiteSpace: "nowrap" }}>{children}</span>;
}
function Eyebrow({ ui, children, style }) { return <div style={Object.assign({ fontFamily: ui.HEAD, fontWeight: 700, fontSize: 11.5, color: T.mute, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 8 }, style || {})}>{children}</div>; }
function H2({ ui, children, style }) { return <div style={Object.assign({ fontFamily: ui.HEAD, fontWeight: 700, fontSize: 17, color: T.ink }, style || {})}>{children}</div>; }
function Empty({ ui, icon, title, body }) {
  return <div style={{ textAlign: "center", padding: "28px 16px", color: T.sub }}>
    {icon && <div style={{ display: "inline-flex", width: 44, height: 44, borderRadius: 12, background: T.navySoft, alignItems: "center", justifyContent: "center", marginBottom: 10 }}><Icon ui={ui} name={icon} size={22} color={T.navy} /></div>}
    <div style={{ fontFamily: ui.HEAD, fontWeight: 700, color: T.ink, fontSize: 15 }}>{title}</div>
    {body && <div style={{ fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{body}</div>}
  </div>;
}
const inputStyle = { width: "100%", boxSizing: "border-box", padding: "10px 12px", border: `1px solid ${T.line}`, borderRadius: 10, fontSize: 14, color: T.ink, background: "#fff", outline: "none" };
function Field({ label, children, style }) { return <label style={Object.assign({ display: "block" }, style || {})}><div style={{ fontSize: 11.5, fontWeight: 700, color: T.sub, marginBottom: 4, letterSpacing: 0.3 }}>{label}</div>{children}</label>; }
function Toast({ toast }) {
  if (!toast) return null;
  const bg = toast.kind === "error" ? T.red : T.ink;
  return <div style={{ position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", background: bg, color: "#fff", padding: "10px 16px", borderRadius: 999, fontSize: 13.5, fontWeight: 600, boxShadow: "0 6px 20px rgba(0,0,0,0.18)", zIndex: 50, maxWidth: "90vw" }}>{toast.msg}</div>;
}
function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  function notify(msg, kind) { clearTimeout(timer.current); setToast({ msg, kind }); timer.current = setTimeout(() => setToast(null), 2600); }
  return [toast, notify];
}
function Sheet({ ui, title, body, confirmLabel, confirmKind, onConfirm, onCancel, children }) {
  return <div onClick={onCancel} style={{ position: "fixed", inset: 0, background: "rgba(14,31,60,0.45)", zIndex: 40, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
    <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: "18px 18px 0 0", padding: "20px 18px 26px", width: "100%", maxWidth: 480 }}>
      <H2 ui={ui}>{title}</H2>
      {body && <div style={{ color: T.sub, fontSize: 14, marginTop: 6, lineHeight: 1.5 }}>{body}</div>}
      {children}
      <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
        <Btn ui={ui} kind="ghost" onClick={onCancel} style={{ flex: 1 }}>Cancel</Btn>
        <Btn ui={ui} kind={confirmKind || "primary"} onClick={onConfirm} style={{ flex: 1 }}>{confirmLabel || "Confirm"}</Btn>
      </div>
    </div>
  </div>;
}
function TopBar({ ui, title, sub, onBack, right }) {
  return <div style={{ background: T.navy, padding: "14px 16px", display: "flex", alignItems: "center", gap: 10, minHeight: 58, boxSizing: "border-box" }}>
    {onBack && <button onClick={onBack} aria-label="Back" style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", padding: 4, lineHeight: 0, marginLeft: -6 }}><Icon ui={ui} name="ChevronLeft" size={24} color="#fff" /></button>}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontFamily: ui.HEAD, fontWeight: 700, fontSize: 17, color: "#fff", letterSpacing: 0.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
      {sub && <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, marginTop: 1 }}>{sub}</div>}
    </div>
    {right}
  </div>;
}
function ProofMark({ size }) {
  const s = size || 28;
  return <span style={{ display: "inline-flex", width: s, height: s, borderRadius: s * 0.26, background: T.navy, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
    <svg width={s * 0.6} height={s * 0.6} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
  </span>;
}

/* =========================================================================
   MERCHANDISER
   ========================================================================= */

function MerchApp({ ui, boot, onLogout, onRefresh }) {
  const [tab, setTab] = useState("today");
  const [screen, setScreen] = useState({ name: "home" }); // home | store | done
  const [openVisit, setOpenVisit] = useState(null);      // { visit, storeName }
  const [mine, setMine] = useState([]);                  // today's visits
  const [toast, notify] = useToast();

  function refreshStatus() {
    jget(ui, "/api/visits/open").then((r) => setOpenVisit(r && r.open ? r : null)).catch(() => {});
    jget(ui, "/api/visits/mine").then((r) => setMine((r && r.visits) || [])).catch(() => {});
  }
  useEffect(refreshStatus, []);

  const storeNames = useMemo(() => {
    const m = {};
    [boot.myDay, boot.tomorrow].forEach((d) => (d && d.blocks || []).forEach((b) => (b.stores || []).forEach((s) => { m[s.storeId] = s.storeName || s.storeId; })));
    return m;
  }, [boot]);

  if (screen.name === "store") {
    return <>
      <StoreFlow ui={ui} storeId={screen.storeId} storeName={storeNames[screen.storeId]} openVisit={openVisit} notify={notify}
        onExit={() => { setScreen({ name: "home" }); refreshStatus(); }}
        onFinished={(summary) => { setScreen({ name: "done", summary, storeId: screen.storeId }); refreshStatus(); onRefresh && onRefresh(); }} />
      <Toast toast={toast} />
    </>;
  }
  if (screen.name === "done") {
    return <DoneScreen ui={ui} summary={screen.summary} storeName={storeNames[screen.storeId]} onHome={() => setScreen({ name: "home" })} />;
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: T.bg }}>
      <TopBar ui={ui} title={tab === "today" ? "Today" : "Leaderboard"} sub={tab === "today" ? fmtDay(boot.date) : monthLabel(String(boot.date || "").slice(0, 7))}
        right={<button onClick={onLogout} style={{ background: "rgba(255,255,255,0.12)", border: "none", color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: "6px 10px", borderRadius: 8 }}>Sign out</button>} />
      <div style={{ flex: 1, overflowY: "auto", padding: 16, paddingBottom: 24 }}>
        {openVisit && (
          <Card accent={T.amber} style={{ background: T.amberSoft, borderColor: "#F1DDA6" }}>
            <div style={{ display: "flex", gap: 10 }}>
              <Icon ui={ui} name="AlertTriangle" size={20} color={T.amber} />
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: ui.HEAD, fontWeight: 700, fontSize: 15, color: T.ink }}>You still have a visit open</div>
                <div style={{ fontSize: 13.5, color: T.sub, marginTop: 2 }}><b style={{ color: T.ink }}>{openVisit.storeName}</b> · started {fmtTime(openVisit.visit.startedAt)}</div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <Btn ui={ui} small onClick={() => setScreen({ name: "store", storeId: openVisit.visit.storeId })}>I'm still there</Btn>
                  <Btn ui={ui} small kind="ghost" onClick={async () => { await jpost(ui, "/api/visits/" + openVisit.visit.id + "/forgotten", {}); notify("Visit closed"); refreshStatus(); }}>I finished there</Btn>
                </div>
              </div>
            </div>
          </Card>
        )}
        {tab === "today" && <TodayList ui={ui} boot={boot} mine={mine} openVisit={openVisit} onOpen={(id) => setScreen({ name: "store", storeId: id })} />}
        {tab === "board" && <LeaderboardScreen ui={ui} me={boot.me} />}
      </div>
      <div style={{ display: "flex", borderTop: `1px solid ${T.line}`, background: "#fff", paddingBottom: "env(safe-area-inset-bottom)" }}>
        {[["today", "Today", "ClipboardList"], ["board", "Leaderboard", "Users"]].map(([id, label, icon]) => (
          <button key={id} onClick={() => setTab(id)} style={{ flex: 1, padding: "10px 0 8px", border: "none", background: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <Icon ui={ui} name={icon} size={20} color={tab === id ? T.navy : T.mute} />
            <span style={{ fontSize: 11, fontWeight: 700, color: tab === id ? T.navy : T.mute }}>{label}</span>
          </button>
        ))}
      </div>
      <Toast toast={toast} />
    </div>
  );
}

function TodayList({ ui, boot, mine, openVisit, onOpen }) {
  const byStore = {};
  (mine || []).forEach((v) => { byStore[v.storeId] = v; });
  const today = boot.myDay, tomorrow = boot.tomorrow;
  const totalStores = (today && today.blocks || []).reduce((n, b) => n + (b.stores || []).length, 0);
  const doneStores = (today && today.blocks || []).reduce((n, b) => n + (b.stores || []).filter((s) => byStore[s.storeId] && byStore[s.storeId].endedAt).length, 0);

  function StoreRow({ s }) {
    const v = byStore[s.storeId];
    const isOpen = openVisit && openVisit.visit && String(openVisit.visit.storeId) === String(s.storeId);
    const done = v && v.endedAt && v.closeReason === "manual";
    return <button onClick={() => onOpen(s.storeId)} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "12px 4px", border: "none", borderTop: `1px solid ${T.line}`, background: "none", cursor: "pointer", textAlign: "left" }}>
      <span style={{ width: 28, height: 28, borderRadius: 999, display: "inline-flex", alignItems: "center", justifyContent: "center", background: done ? T.greenSoft : isOpen ? T.amberSoft : T.navySoft, flexShrink: 0 }}>
        {done ? <Icon ui={ui} name="Check" size={15} color={T.green} /> : <Icon ui={ui} name="MapPin" size={14} color={isOpen ? T.amber : T.navy} />}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: T.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.storeName || s.storeId}</div>
        <div style={{ fontSize: 12, color: T.sub, marginTop: 1 }}>
          {done ? `Done · ${v.items} items · ${v.photos} photo${v.photos === 1 ? "" : "s"}` : isOpen ? "Visit in progress" : s.pull > 1 ? "2nd pull" : "Tap to start"}
        </div>
      </span>
      {!s.mapped && !done && <Badge tone="amber">No plan</Badge>}
      <Icon ui={ui} name="ChevronRight" size={17} color={T.mute} />
    </button>;
  }
  function BlockCard({ b }) {
    return <Card pad={"14px 14px 4px"} accent={b.truck ? T.amber : undefined}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <Icon ui={ui} name="Clock" size={15} color={T.sub} />
        <div style={{ fontWeight: 700, color: T.ink, fontSize: 14 }}>{fmtStart(b.startTime)}</div>
        {b.truck && <Badge tone="amber">Truck day</Badge>}
        {b.note && <span style={{ fontSize: 12, color: T.sub }}>· {b.note}</span>}
      </div>
      {(b.stores || []).length ? b.stores.map((s) => <StoreRow key={s.id} s={s} />) : <div style={{ color: T.mute, fontSize: 13, padding: "6px 0 10px" }}>No stores on this block yet.</div>}
    </Card>;
  }

  return <div>
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
      <div style={{ fontFamily: ui.HEAD, fontWeight: 800, fontSize: 22, color: T.ink }}>Hi, {String(boot.me.name || "").split(" ")[0]}</div>
      {totalStores > 0 && <div style={{ fontSize: 13, color: T.sub }}><b style={{ color: doneStores === totalStores ? T.green : T.ink }}>{doneStores}</b> of {totalStores} stores done</div>}
    </div>
    {totalStores > 0 && <div style={{ height: 6, borderRadius: 999, background: T.navySoft, marginBottom: 16, overflow: "hidden" }}><div style={{ width: (100 * doneStores / totalStores) + "%", height: "100%", background: T.green, transition: "width .3s" }} /></div>}
    {(!today || !today.blocks || !today.blocks.length) ? <Card><Empty ui={ui} icon="ClipboardList" title="Nothing on the board today" body="When your admin schedules your team, the stores show up here." /></Card>
      : today.blocks.map((b) => <BlockCard key={b.id} b={b} />)}
    {tomorrow && tomorrow.blocks && tomorrow.blocks.length > 0 && <>
      <Eyebrow ui={ui} style={{ marginTop: 22 }}>Tomorrow · {fmtDay(tomorrow.date)}</Eyebrow>
      {tomorrow.blocks.map((b) => <Card key={b.id} pad={12} style={{ background: T.panel }}>
        <div style={{ fontSize: 13, color: T.ink, fontWeight: 600, marginBottom: 4 }}>{fmtStart(b.startTime)} {b.truck ? "· Truck day" : ""}</div>
        <div style={{ fontSize: 12.5, color: T.sub, lineHeight: 1.5 }}>{(b.stores || []).map((s) => s.storeName || s.storeId).join(" · ") || "No stores yet"}</div>
      </Card>)}
    </>}
  </div>;
}

function LeaderboardScreen({ ui, me }) {
  const [board, setBoard] = useState(null);
  useEffect(() => { jget(ui, "/api/leaderboard").then((r) => setBoard((r && r.board) || [])).catch(() => setBoard([])); }, []);
  if (!board) return <div style={{ color: T.mute, textAlign: "center", padding: 20 }}>Loading…</div>;
  if (!board.length) return <Card><Empty ui={ui} icon="Users" title="No points yet this month" body="Every visit you finish earns 10 points, plus 1 per photo (up to 10)." /></Card>;
  return <Card pad={"6px 14px"}>
    {board.map((r, i) => {
      const isMe = me && r.merchId === me.id;
      return <div key={r.merchId} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: i ? `1px solid ${T.line}` : "none" }}>
        <div style={{ width: 28, height: 28, borderRadius: 999, display: "grid", placeItems: "center", background: i === 0 ? T.navy : T.navySoft, color: i === 0 ? "#fff" : T.navy, fontWeight: 800, fontSize: 13 }}>{i + 1}</div>
        <div style={{ flex: 1, fontWeight: isMe ? 800 : 600, color: T.ink }}>{r.name}{isMe && <span style={{ color: T.mute, fontWeight: 600 }}> · you</span>}</div>
        <div style={{ fontFamily: ui.HEAD, fontWeight: 800, color: T.navy, fontSize: 16 }}>{r.points}</div>
      </div>;
    })}
  </Card>;
}

/* ---- One store: pre-visit -> in-visit walk. ---- */
const STATUS = [["stocked", "Stocked", "green"], ["out_of_stock", "Out", "red"], ["not_carried", "Not carried", "gray"], ["fixed", "Fixed", "green"]];
function StoreFlow({ ui, storeId, storeName, openVisit, notify, onExit, onFinished }) {
  const [detail, setDetail] = useState(null);
  const [visit, setVisit] = useState(null);
  const [statuses, setStatuses] = useState({});    // planItemId -> status
  const [photoCounts, setPhotoCounts] = useState({ total: 0, byGroup: {} });
  const [thumbs, setThumbs] = useState({});        // groupKey -> [dataUrl] (this session only)
  const [starting, setStarting] = useState(false);
  const [working, setWorking] = useState(null); // the category this visit is for
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef(null);
  const pendingGroup = useRef(null);

  // The plan is re-read once a category is chosen, so the walk only shows
  // what belongs to it -- a beer trip should not scroll past the water.
  useEffect(() => {
    const qs = working ? "?category=" + encodeURIComponent(working) : "";
    jget(ui, "/api/stores/" + encodeURIComponent(storeId) + "/detail" + qs).then((d) => { if (d && d.error) setErr(d.error); else setDetail(d); });
  }, [storeId, working]);
  useEffect(() => {
    // Resume: the open visit at THIS store, with what was already checked.
    if (openVisit && openVisit.visit && String(openVisit.visit.storeId) === String(storeId)) {
      setVisit(openVisit.visit);
      setWorking(openVisit.visit.category || null);
      jget(ui, "/api/visits/" + openVisit.visit.id).then((d) => {
        if (!d || d.error) return;
        const st = {};
        (d.items || []).forEach((r) => { if (r.planItemId != null) st[r.planItemId] = r.status; }); // in order: last wins
        setStatuses(st);
        setPhotoCounts({ total: (d.photos || []).length, byGroup: {} });
      });
    }
  }, [storeId]);

  const groups = (detail && detail.plan && detail.plan.groups) || [];
  const totalItems = groups.reduce((n, g) => n + g.items.length, 0);
  const CATS = [{ id: "beer", label: "Beer" }, { id: "na", label: "Non-alc" }];
  const planCats = CATS.filter((c) => ((detail && detail.plan && detail.plan.categories) || []).indexOf(c.id) !== -1);

  /* Brands within one aisle, in the order the plan lists them. The KEY is
     aisle + brand, so Liquid Death in the cooler and Liquid Death on the
     energy shelf are two blocks wanting two photos, while a brand that sits
     in one place is one block wanting one. */
  function brandBlocks(g) {
    const by = new Map();
    (g.items || []).forEach((it) => {
      const brand = (it.brand || "").trim() || it.name;
      const key = "b|" + g.aisle + "|" + brand.toLowerCase();
      if (!by.has(key)) by.set(key, { key, brand, sectionId: it.sectionId || null, items: [] });
      by.get(key).items.push(it);
    });
    return [...by.values()];
  }
  const allBlocks = useMemo(() => groups.flatMap((g) => brandBlocks(g)), [detail]);
  const shotBrands = allBlocks.filter((b) => (photoCounts.byGroup[b.key] || 0) > 0).length;
  const checked = Object.keys(statuses).length;
  const blockedElsewhere = openVisit && openVisit.visit && String(openVisit.visit.storeId) !== String(storeId);

  async function startVisit(category) {
    setStarting(true); setErr("");
    const geo = await getGeo();
    const r = await jpost(ui, "/api/visits/start", { storeId, atClient: new Date().toISOString(), category: category || null, ...geo });
    setStarting(false);
    if (!r || r.error) { setErr(r && r.error ? r.error : "Couldn't start the visit."); return; }
    setVisit(r.visit);
    setWorking(category || null);
    if (r.open) notify("Resumed your open visit");
  }
  function touchSection(g) {
    const sid = g.items[0] && g.items[0].sectionId;
    if (visit && sid != null) jpost(ui, "/api/visits/" + visit.id + "/section-enter", { sectionId: sid, atClient: new Date().toISOString() }).catch(() => {});
  }
  async function setStatus(g, item, status) {
    if (!visit) return;
    touchSection(g);
    setStatuses((s) => Object.assign({}, s, { [item.id]: status }));
    const r = await jpost(ui, "/api/visits/" + visit.id + "/item-result", { planItemId: item.id, status }).catch(() => null);
    if (!r || r.error) notify("Couldn't save that — check your connection", "error");
  }
  // target = { aisle, brand, sectionId } -- the brand block the camera sits on.
  function takePhoto(target) { pendingGroup.current = target; fileRef.current && fileRef.current.click(); }
  async function onFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    const t = pendingGroup.current;
    if (!f || !visit || !t) return;
    try {
      const { dataUrl, mime } = await compressPhoto(f, 1200, 0.75);
      if (t.sectionId != null) jpost(ui, "/api/visits/" + visit.id + "/section-enter", { sectionId: t.sectionId, atClient: new Date().toISOString() }).catch(() => {});
      const r = await jpost(ui, "/api/visits/" + visit.id + "/photo", { sectionId: t.sectionId != null ? t.sectionId : null, brand: t.brand || null, aisle: t.aisle || null, dataUrl, mime });
      if (!r || r.error) throw new Error("save failed");
      const k = t.brand ? "b|" + t.aisle + "|" + String(t.brand).toLowerCase() : "loose";
      setThumbs((th) => Object.assign({}, th, { [k]: [...(th[k] || []), dataUrl] }));
      setPhotoCounts((c) => ({ total: c.total + 1, byGroup: Object.assign({}, c.byGroup, { [k]: (c.byGroup[k] || 0) + 1 }) }));
      notify("Photo saved");
    } catch (e) { notify("Couldn't save the photo — try again", "error"); }
  }
  async function endVisit() {
    setEnding(true);
    const r = await jpost(ui, "/api/visits/" + visit.id + "/end", { atClient: new Date().toISOString() }).catch(() => null);
    setEnding(false); setConfirmEnd(false);
    if (!r || r.error) { notify("Couldn't end the visit — try again", "error"); return; }
    onFinished(r.summary || {});
  }

  const store = detail && detail.store;
  const title = (store && store.name) || storeName || "Store";
  const addr = store ? [store.addr, store.city].filter(Boolean).join(", ") : "";

  /* ---- pre-visit ---- */
  if (!visit) {
    return <div style={{ height: "100%", display: "flex", flexDirection: "column", background: T.bg }}>
      <TopBar ui={ui} title={title} sub={addr} onBack={onExit} />
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {err && <Card accent={T.red} style={{ background: T.redSoft, borderColor: "#F3C4C0" }}><div style={{ color: T.red, fontSize: 13.5 }}>{err}</div></Card>}
        {!detail ? <div style={{ color: T.mute, textAlign: "center", padding: 24 }}>Loading…</div> : <>
          {store && store.chain && <div style={{ marginBottom: 12 }}><Badge tone="navy">{store.chain}</Badge></div>}
          <Card>
            <Eyebrow ui={ui}>The plan for this store</Eyebrow>
            {totalItems ? <>
              <div style={{ fontFamily: ui.HEAD, fontWeight: 800, fontSize: 26, color: T.ink }}>{totalItems} <span style={{ fontSize: 15, fontWeight: 600, color: T.sub }}>items across {groups.length} aisle{groups.length === 1 ? "" : "s"}</span></div>
              <div style={{ fontSize: 13, color: T.sub, marginTop: 10, lineHeight: 1.6 }}>{groups.map((g) => `Aisle ${g.aisle} (${g.items.length})`).join(" · ")}</div>
            </> : <div style={{ fontSize: 14, color: T.sub, lineHeight: 1.5 }}>No plan has been mapped for this store yet. You can still start a visit and photograph what you did.</div>}
          </Card>
          {blockedElsewhere ? <Card accent={T.amber} style={{ background: T.amberSoft, borderColor: "#F1DDA6" }}>
            <div style={{ fontWeight: 700, color: T.ink, fontSize: 14.5 }}>Finish your visit at {openVisit.storeName} first</div>
            <div style={{ fontSize: 13, color: T.sub, marginTop: 4, lineHeight: 1.5 }}>Only one visit can be open at a time. Go back to Today to close it.</div>
          </Card> : <>
            {/* What are you working? Asked ONLY when this store's plan
                actually spans more than one category -- otherwise it is a
                pointless tap. One category per visit: working beer and then
                non-alc at the same store is two visits, which keeps "how
                long did beer take" a measured number instead of a guess. */}
            {planCats.length > 1 ? <Card>
              <Eyebrow ui={ui}>What are you working?</Eyebrow>
              <div style={{ display: "grid", gap: 8 }}>
                {planCats.map((c) => (
                  <Btn key={c.id} ui={ui} block kind={c.id === "beer" ? "primary" : "ghost"} disabled={starting} onClick={() => startVisit(c.id)}>
                    {starting ? "Starting…" : c.label}
                  </Btn>
                ))}
                <button onClick={() => startVisit(null)} disabled={starting} style={{ background: "none", border: "none", color: T.sub, fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: "6px 0" }}>Both / everything</button>
              </div>
            </Card> : <>
              <Btn ui={ui} block icon="MapPin" onClick={() => startVisit(planCats[0] ? planCats[0].id : null)} disabled={starting}>{starting ? "Getting your location…" : "Start Visit"}</Btn>
              <div style={{ fontSize: 12, color: T.mute, textAlign: "center", marginTop: 10 }}>Your location is noted when you start. That's it — no clock to watch.</div>
            </>}
          </>}
        </>}
      </div>
    </div>;
  }

  /* ---- in-visit ---- */
  return <div style={{ height: "100%", display: "flex", flexDirection: "column", background: T.bg }}>
    <TopBar ui={ui} title={title} sub={working ? "Working " + (CATS.find((c) => c.id === working) || {}).label : "Visit in progress"} onBack={onExit} right={<Badge tone="green">LIVE</Badge>} />
    <div style={{ padding: "10px 16px", borderBottom: `1px solid ${T.line}`, display: "flex", alignItems: "center", gap: 12, background: "#fff" }}>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: T.sub, marginBottom: 5 }}>
          <span><b style={{ color: T.ink }}>{checked}</b> of {totalItems} checked</span>
          <span style={{ color: allBlocks.length && shotBrands === allBlocks.length ? T.green : T.sub }}>
            <b style={{ color: allBlocks.length && shotBrands === allBlocks.length ? T.green : T.ink }}>{shotBrands}</b> of {allBlocks.length} brand{allBlocks.length === 1 ? "" : "s"} shot
          </span>
        </div>
        <div style={{ height: 5, borderRadius: 999, background: T.navySoft, overflow: "hidden" }}><div style={{ width: (totalItems ? 100 * checked / totalItems : 0) + "%", height: "100%", background: T.green, transition: "width .25s" }} /></div>
      </div>
    </div>
    <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onFile} />
    <div style={{ flex: 1, overflowY: "auto", padding: 16, paddingBottom: 100 }}>
      {!groups.length && <Card><Empty ui={ui} icon="Camera" title="No plan to check off" body="Photograph the work you did, then end the visit." /><Btn ui={ui} block kind="subtle" icon="Camera" onClick={() => takePhoto({ aisle: "", brand: "", sectionId: null })}>Take a photo</Btn></Card>}
      {groups.map((g) => {
        const gChecked = g.items.filter((it) => statuses[it.id]).length;
        return <Card key={g.aisle} pad={"12px 14px"}>
          <div style={{ marginBottom: 6 }}>
            <div style={{ fontFamily: ui.HEAD, fontWeight: 700, fontSize: 15, color: T.ink }}>{g.aisle && g.aisle !== "—" ? "Aisle " + g.aisle : "This store"}{g.items[0] && g.items[0].sectionLabel ? <span style={{ color: T.sub, fontWeight: 600 }}> · {g.items[0].sectionLabel}</span> : null}</div>
            <div style={{ fontSize: 12, color: gChecked === g.items.length ? T.green : T.mute, fontWeight: 600 }}>{gChecked}/{g.items.length} checked</div>
          </div>
          {/* One block per BRAND in this aisle. The camera lives here, not on
              the aisle and not on the SKU: one picture covers the brand where
              it sits, and a brand that sits in three places gets three blocks
              and can be photographed in each. */}
          {brandBlocks(g).map((b) => {
            const k = b.key;
            const shots = photoCounts.byGroup[k] || 0;
            return <div key={k} style={{ borderTop: `1px solid ${T.line}`, paddingTop: 10, marginTop: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: ui.HEAD, fontWeight: 700, fontSize: 14, color: shots ? T.green : T.ink }}>{b.brand}</div>
                  <div style={{ fontSize: 11.5, color: T.mute }}>{b.items.length} item{b.items.length === 1 ? "" : "s"}{shots ? ` · ${shots} photo${shots === 1 ? "" : "s"}` : " · needs a photo"}</div>
                </div>
                <button onClick={() => takePhoto({ aisle: g.aisle, brand: b.brand, sectionId: b.sectionId })} aria-label={"Photo of " + b.brand}
                  style={{ width: 44, height: 44, borderRadius: 12, border: `1.5px solid ${shots ? T.green : T.navy}`, background: shots ? T.greenSoft : "#fff", cursor: "pointer", display: "grid", placeItems: "center", position: "relative", flexShrink: 0 }}>
                  <Icon ui={ui} name="Camera" size={20} color={shots ? T.green : T.navy} />
                  {shots > 0 && <span style={{ position: "absolute", top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 999, background: T.green, color: "#fff", fontSize: 10.5, fontWeight: 800, display: "grid", placeItems: "center", padding: "0 4px" }}>{shots}</span>}
                </button>
              </div>
              {(thumbs[k] || []).length > 0 && <div style={{ display: "flex", gap: 6, margin: "0 0 8px", overflowX: "auto" }}>{thumbs[k].map((u, i) => <img key={i} src={u} alt="" style={{ width: 54, height: 54, objectFit: "cover", borderRadius: 8, border: `1px solid ${T.line}`, flexShrink: 0 }} />)}</div>}
              {b.items.map((it) => {
            const cur = statuses[it.id];
            return <div key={it.id} style={{ padding: "8px 0" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <div style={{ fontWeight: 600, color: T.ink, fontSize: 14, flex: 1 }}>{it.name}</div>
                {it.itemNo && <span style={{ fontSize: 11.5, color: T.mute }}>#{it.itemNo}</span>}
              </div>
              {(it.bay || it.shelf || it.note) && <div style={{ fontSize: 12, color: T.sub, marginTop: 1, marginBottom: 8 }}>{[it.bay && "Bay " + it.bay, it.shelf && "Shelf " + it.shelf, it.note].filter(Boolean).join(" · ")}</div>}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginTop: it.bay || it.shelf || it.note ? 0 : 8 }}>
                {STATUS.map(([v, label, tone]) => {
                  const on = cur === v;
                  const fg = tone === "green" ? T.green : tone === "red" ? T.red : T.sub;
                  const bg = tone === "green" ? T.greenSoft : tone === "red" ? T.redSoft : T.panel;
                  return <button key={v} onClick={() => setStatus(g, it, v)} style={{ padding: "9px 4px", borderRadius: 9, border: `1.5px solid ${on ? fg : T.line}`, background: on ? bg : "#fff", color: on ? fg : T.sub, fontSize: 12, fontWeight: 700, cursor: "pointer", lineHeight: 1.1 }}>{label}</button>;
                })}
              </div>
            </div>;
              })}
            </div>;
          })}
        </Card>;
      })}
    </div>
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "12px 16px", paddingBottom: "calc(12px + env(safe-area-inset-bottom))", background: "linear-gradient(to top, #fff 70%, rgba(255,255,255,0))" }}>
      <Btn ui={ui} block kind="green" icon="Check" onClick={() => setConfirmEnd(true)}>End Visit</Btn>
    </div>
    {confirmEnd && <Sheet ui={ui} title="End this visit?" confirmLabel={ending ? "Ending…" : "End Visit"} confirmKind="green" onCancel={() => setConfirmEnd(false)} onConfirm={ending ? () => {} : endVisit}
      body={<>
        You checked <b>{checked}</b> of {totalItems} items and photographed <b>{shotBrands}</b> of {allBlocks.length} brand{allBlocks.length === 1 ? "" : "s"}.
        {shotBrands < allBlocks.length ? <> {allBlocks.length - shotBrands} still {allBlocks.length - shotBrands === 1 ? "has" : "have"} no picture.</> : ""}
        {checked < totalItems && totalItems > 0 ? " Unchecked items are fine — they just won't count." : ""}
      </>} />}
  </div>;
}

function DoneScreen({ ui, summary, storeName, onHome }) {
  const s = summary || {};
  return <div style={{ height: "100%", display: "flex", flexDirection: "column", background: T.bg, alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
    <div style={{ width: 84, height: 84, borderRadius: 999, background: T.greenSoft, display: "grid", placeItems: "center", marginBottom: 18 }}><Icon ui={ui} name="Check" size={44} color={T.green} /></div>
    <div style={{ fontFamily: ui.HEAD, fontWeight: 800, fontSize: 26, color: T.ink }}>Visit logged</div>
    {storeName && <div style={{ color: T.sub, fontSize: 14, marginTop: 4 }}>{storeName}</div>}
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, width: "100%", maxWidth: 360, marginTop: 24 }}>
      {[[s.items, "items checked"], [s.photos, "photos"], [s.points != null ? "+" + s.points : "—", "points"]].map(([v, l]) => (
        <div key={l} style={{ background: T.panel, borderRadius: 12, padding: "14px 8px" }}>
          <div style={{ fontFamily: ui.HEAD, fontWeight: 800, fontSize: 22, color: l === "points" ? T.green : T.ink }}>{v == null ? "—" : v}</div>
          <div style={{ fontSize: 11.5, color: T.sub, marginTop: 2 }}>{l}</div>
        </div>
      ))}
    </div>
    <Btn ui={ui} block onClick={onHome} style={{ maxWidth: 360, marginTop: 26 }}>Back to Today</Btn>
  </div>;
}

/* =========================================================================
   ADMIN (desktop)
   ========================================================================= */

const ADMIN_TABS = [["schedule", "Schedule", "CalendarDays"], ["stores", "Stores", "MapPin"], ["catalog", "Catalog & plans", "ClipboardList"], ["team", "Team", "Users"], ["devices", "Devices", "ShieldCheck"], ["live", "Live", "Clock"], ["reporting", "Reporting", "Search"]];

function AdminApp({ ui, boot, onLogout }) {
  const [tab, setTab] = useState("schedule");
  const [toast, notify] = useToast();
  return <div style={{ height: "100%", display: "flex", flexDirection: "column", background: T.panel }}>
    <div style={{ background: T.navy, padding: "0 22px", display: "flex", alignItems: "center", gap: 22, height: 58 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}><ProofMark size={28} /><div style={{ fontFamily: ui.HEAD, fontWeight: 800, fontSize: 18, color: "#fff", letterSpacing: 0.5 }}>PROOF</div></div>
      <div style={{ display: "flex", gap: 2, flex: 1, height: "100%" }}>
        {ADMIN_TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{ padding: "0 14px", border: "none", borderBottom: `3px solid ${tab === id ? "#fff" : "transparent"}`, background: "none", color: tab === id ? "#fff" : "rgba(255,255,255,0.65)", fontWeight: 600, fontSize: 13.5, cursor: "pointer", fontFamily: ui.HEAD }}>{label}</button>
        ))}
      </div>
      <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 12.5 }}>{boot && boot.me && boot.me.name}</div>
      <button onClick={onLogout} style={{ background: "rgba(255,255,255,0.12)", border: "none", color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer", padding: "6px 10px", borderRadius: 8 }}>Sign out</button>
    </div>
    <div style={{ flex: 1, overflow: "auto", padding: 22 }}>
      {tab === "schedule" && <ScheduleBoard ui={ui} notify={notify} />}
      {tab === "stores" && <StoresPanel ui={ui} notify={notify} />}
      {tab === "catalog" && <CatalogPanel ui={ui} notify={notify} />}
      {tab === "team" && <TeamPanel ui={ui} notify={notify} />}
      {tab === "devices" && <DevicesPanel ui={ui} notify={notify} />}
      {tab === "live" && <LivePanel ui={ui} />}
      {tab === "reporting" && <ReportingPanel ui={ui} />}
    </div>
    <Toast toast={toast} />
  </div>;
}

function PanelHead({ ui, title, body, right }) {
  return <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
    <div style={{ flex: 1 }}>
      <div style={{ fontFamily: ui.HEAD, fontWeight: 800, fontSize: 22, color: T.ink }}>{title}</div>
      {body && <div style={{ color: T.sub, fontSize: 13.5, marginTop: 3, maxWidth: 720, lineHeight: 1.5 }}>{body}</div>}
    </div>
    {right}
  </div>;
}

/* ---- Schedule: the week board. Drag a team or a person onto a block. ---- */
function Chip({ label, color, outline, onRemove, draggable, onDragStart, small }) {
  return <span draggable={draggable} onDragStart={onDragStart} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: small ? "3px 8px" : "6px 10px", borderRadius: 8, background: outline ? "#fff" : (color ? color + "22" : T.navySoft), border: `1px solid ${outline ? T.navy : (color || T.line)}`, color: outline ? T.navy : T.ink, fontSize: small ? 11.5 : 12.5, fontWeight: 600, cursor: draggable ? "grab" : "default", userSelect: "none" }}>
    {color && !outline && <span style={{ width: 8, height: 8, borderRadius: 999, background: color }} />}
    {label}
    {onRemove && <button onClick={onRemove} aria-label="Remove" style={{ background: "none", border: "none", padding: 0, marginLeft: 2, lineHeight: 0, cursor: "pointer", color: T.mute, fontSize: 14 }}>×</button>}
  </span>;
}
function ScheduleBoard({ ui, notify }) {
  const [week, setWeek] = useState(null);
  const [teams, setTeams] = useState([]);
  const [people, setPeople] = useState([]);
  const [hover, setHover] = useState(null);
  const drag = useRef(null);
  const [confirm, setConfirm] = useState(null);

  function reload() {
    Promise.all([jget(ui, "/api/week"), jget(ui, "/api/teams"), jget(ui, "/api/people")])
      .then(([w, t, p]) => { setWeek((w && w.days) || [[], [], [], [], [], [], []]); setTeams((t && t.teams) || []); setPeople((p && p.people) || []); });
  }
  useEffect(reload, []);

  const teamById = useMemo(() => { const m = {}; teams.forEach((t) => { m[t.id] = t; }); return m; }, [teams]);
  const teamMembers = useMemo(() => { const m = {}; people.forEach((p) => { if (p.teamId && p.active) (m[p.teamId] = m[p.teamId] || []).push(p); }); return m; }, [people]);
  function teamIdsOf(blockId) { for (const day of (week || [])) for (const b of day) if (b.id === blockId) return b.teamIds || []; return []; }

  async function drop(blockId) {
    const d = drag.current; drag.current = null; setHover(null);
    if (!d) return;
    if (d.kind === "team") {
      const ids = teamIdsOf(blockId); if (ids.indexOf(d.id) !== -1) return;
      await jpost(ui, "/api/blocks/" + blockId, { teamIds: [...ids, d.id] }); notify("Team added");
    } else {
      await jpost(ui, "/api/blocks/" + blockId + "/members", { personId: d.id }); notify("Added to this block");
    }
    reload();
  }
  async function dropOnDay(weekday) {
    const d = drag.current; drag.current = null; setHover(null);
    if (!d) return;
    const r = await jpost(ui, "/api/blocks", { weekday, teamIds: d.kind === "team" ? [d.id] : [] });
    if (d.kind === "person" && r && r.id) await jpost(ui, "/api/blocks/" + r.id + "/members", { personId: d.id });
    notify("New block added"); reload();
  }
  async function update(blockId, patch, msg) { await jpost(ui, "/api/blocks/" + blockId, patch); if (msg) notify(msg); reload(); }

  if (!week) return <div style={{ color: T.mute }}>Loading the board…</div>;
  const merchPeople = people.filter((p) => p.role === "merch" && p.active);

  return <div>
    <PanelHead ui={ui} title="Weekly schedule" body="The same route every week — only who works it changes. Drag a team or a single person onto a block; drop onto an empty part of a day to make a new block. Truck days default to a 4:30 AM start." />
    {/* Palette ACROSS THE TOP, not down the side: seven day columns plus a
        220px rail overflowed the window and left the week scrolled off the
        left edge. Full width belongs to the board. */}
    <Card style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ minWidth: 200 }}>
          <Eyebrow ui={ui} style={{ marginBottom: 6 }}>Teams</Eyebrow>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {teams.map((t) => <Chip key={t.id} label={t.name} color={TEAM_HEX[t.color] || TEAM_HEX.slate} draggable onDragStart={() => { drag.current = { kind: "team", id: t.id }; }} />)}
            {!teams.length && <div style={{ fontSize: 12.5, color: T.mute }}>No teams yet — add them on the Team tab.</div>}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 260 }}>
          <Eyebrow ui={ui} style={{ marginBottom: 6 }}>People <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500, color: T.sub }}>— drop one on a block for a one-off cover, without changing their team</span></Eyebrow>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {merchPeople.map((p) => <Chip key={p.id} label={p.name} outline draggable onDragStart={() => { drag.current = { kind: "person", id: p.id }; }} />)}
            {!merchPeople.length && <div style={{ fontSize: 12.5, color: T.mute }}>No merchandisers yet.</div>}
          </div>
        </div>
      </div>
    </Card>
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(150px, 1fr))", gap: 10 }}>
        {WEEK_ORDER.map((wd) => (
          <div key={wd} onDragOver={(e) => { e.preventDefault(); setHover("day" + wd); }} onDragLeave={() => setHover((h) => h === "day" + wd ? null : h)} onDrop={(e) => { e.preventDefault(); if (hover === "day" + wd) dropOnDay(wd); }}
            style={{ minHeight: 320, borderRadius: 12, padding: 6, background: hover === "day" + wd ? T.navySoft : "transparent", transition: "background .15s" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px 8px" }}>
              <div style={{ fontFamily: ui.HEAD, fontWeight: 800, fontSize: 13, color: T.ink }}>{DAYS[wd]}</div>
              <button onClick={() => jpost(ui, "/api/blocks", { weekday: wd }).then(() => { notify("Block added"); reload(); })} title="Add a block" style={{ background: "none", border: `1px solid ${T.line}`, borderRadius: 7, width: 24, height: 24, cursor: "pointer", color: T.navy, fontWeight: 700, lineHeight: 1 }}>+</button>
            </div>
            {(week[wd] || []).map((b) => {
              const isHover = hover === "b" + b.id;
              const viaTeam = (b.teamIds || []).flatMap((tid) => teamMembers[tid] || []);
              return <div key={b.id} onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setHover("b" + b.id); }} onDragLeave={() => setHover((h) => h === "b" + b.id ? null : h)} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(b.id); }}
                style={{ background: "#fff", border: `1.5px ${isHover ? "dashed" : "solid"} ${isHover ? T.navy : b.truck ? "#E9C86A" : T.line}`, borderRadius: 12, padding: 10, marginBottom: 8, boxShadow: "0 1px 2px rgba(16,31,60,0.04)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                  <input type="time" value={b.startTime} onChange={(e) => update(b.id, { startTime: e.target.value })} style={{ fontSize: 12, fontWeight: 700, color: T.ink, border: "none", background: T.panel, borderRadius: 6, padding: "3px 6px", width: 92 }} />
                  <button onClick={() => update(b.id, { truck: !b.truck }, b.truck ? "Truck day off — start back to 8:00" : "Truck day — start set to 4:30")} title="Toggle truck day" style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, padding: "3px 7px", borderRadius: 6, border: "none", cursor: "pointer", background: b.truck ? T.amberSoft : T.panel, color: b.truck ? T.amber : T.mute }}>TRUCK</button>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => setConfirm({ title: "Remove this block?", body: `${DAYS[wd]} ${fmtStart(b.startTime)} — its stores and assignments go with it.`, run: () => jpost(ui, "/api/blocks/" + b.id + "/remove", {}).then(() => { notify("Block removed"); reload(); }) })} aria-label="Remove block" style={{ background: "none", border: "none", cursor: "pointer", padding: 2, lineHeight: 0 }}><Icon ui={ui} name="X" size={14} color={T.mute} /></button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                  {(b.teamIds || []).map((tid) => <Chip key={tid} small label={teamById[tid] ? teamById[tid].name : tid} color={teamById[tid] ? (TEAM_HEX[teamById[tid].color] || TEAM_HEX.slate) : T.line} onRemove={() => update(b.id, { teamIds: teamIdsOf(b.id).filter((x) => x !== tid) }, "Team removed")} />)}
                  {(b.members || []).map((m) => <Chip key={m.id} small outline label={m.name} onRemove={() => jpost(ui, "/api/blocks/" + b.id + "/members", { remove: true, personId: m.id }).then(() => { notify("Removed from this block"); reload(); })} />)}
                  {!(b.teamIds || []).length && !(b.members || []).length && <span style={{ fontSize: 11.5, color: T.mute, fontStyle: "italic" }}>Drop a team or person here</span>}
                </div>
                {viaTeam.length > 0 && <div style={{ fontSize: 11, color: T.mute, marginBottom: 6 }}>{viaTeam.map((p) => p.name.split(" ")[0]).join(", ")}</div>}
                <BlockStores ui={ui} block={b} notify={notify} onChange={reload} />
              </div>;
            })}
            {!(week[wd] || []).length && <div style={{ border: `1.5px dashed ${T.line}`, borderRadius: 12, padding: 14, textAlign: "center", fontSize: 12, color: T.mute }}>Drop a team here to start the day</div>}
          </div>
        ))}
      </div>
    </div>
    {confirm && <Sheet ui={ui} title={confirm.title} body={confirm.body} confirmLabel="Remove" confirmKind="danger" onCancel={() => setConfirm(null)} onConfirm={() => { confirm.run(); setConfirm(null); }} />}
  </div>;
}
function BlockStores({ ui, block, notify, onChange }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState(null); // null = not loaded yet
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Opening the picker LISTS the stores -- searching only after you guess a
  // matching name is how "I can't add stores" happens. Typing then filters,
  // and the server matches name, city, chain, address or route.
  async function load(v) {
    setBusy(true);
    const r = await jget(ui, "/api/stores?limit=25" + (v ? "&q=" + encodeURIComponent(v) : ""));
    setBusy(false);
    if (r && r.error) { notify(r.error, "error"); setResults([]); return; }
    setResults((r && r.stores) || []);
  }
  function openPicker() { setOpen(true); setQ(""); load(""); }
  function search(v) { setQ(v); load(v); }
  async function add(s) {
    const r = await jpost(ui, "/api/blocks/" + block.id + "/stores", { storeId: s.id });
    if (!r || r.error) { notify((r && r.error) || "Couldn't add that store", "error"); return; }
    setQ(""); setResults(null); setOpen(false);
    notify(r.pull > 1 ? `${s.name} added as pull #${r.pull}` : `${s.name} added`);
    onChange();
  }
  return <div style={{ borderTop: `1px solid ${T.line}`, paddingTop: 6 }}>
    {(block.stores || []).map((s, i) => (
      <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "3px 0" }}>
        <span style={{ width: 16, color: T.mute, fontSize: 11, textAlign: "right" }}>{i + 1}</span>
        <span style={{ flex: 1, color: T.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.storeName || s.storeId}>{s.storeName || s.storeId}</span>
        {s.pull > 1 && <Badge tone="navy">{s.pull === 2 ? "2nd" : s.pull + "th"} pull</Badge>}
        {!s.mapped && <span title="No plan mapped yet" style={{ width: 7, height: 7, borderRadius: 999, background: T.amber, flexShrink: 0 }} />}
        <button onClick={() => jpost(ui, "/api/blocks/" + block.id + "/stores", { remove: true, storeId: s.storeId, rowId: s.id }).then(() => { notify("Store removed"); onChange(); })} aria-label="Remove store" style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 0 }}><Icon ui={ui} name="X" size={12} color={T.mute} /></button>
      </div>
    ))}
    {open ? <div style={{ marginTop: 4 }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input autoFocus value={q} onChange={(e) => search(e.target.value)} placeholder="Filter by name, city, chain or route…" style={Object.assign({}, inputStyle, { padding: "6px 8px", fontSize: 12 })} />
        <button onClick={() => { setOpen(false); setQ(""); setResults(null); }} aria-label="Close" style={{ background: "none", border: "none", cursor: "pointer", padding: 2, lineHeight: 0 }}><Icon ui={ui} name="X" size={13} color={T.mute} /></button>
      </div>
      <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, marginTop: 4, maxHeight: 190, overflowY: "auto", background: "#fff" }}>
        {busy && results === null && <div style={{ fontSize: 11.5, color: T.mute, padding: "8px 10px" }}>Loading stores…</div>}
        {results && results.map((s) => (
          <div key={s.id} onClick={() => add(s)} style={{ padding: "7px 10px", fontSize: 12.5, cursor: "pointer", color: T.ink, borderBottom: `1px solid ${T.line}` }}>
            <div style={{ fontWeight: 600 }}>{s.name}</div>
            <div style={{ color: T.mute, fontSize: 11 }}>{[s.city, s.chain, s.route].filter(Boolean).join(" · ")}</div>
          </div>
        ))}
        {results && !results.length && <div style={{ fontSize: 11.5, color: T.mute, padding: "8px 10px", lineHeight: 1.5 }}>
          {q ? <>Nothing matches “{q}”.</> : <>No stores yet — upload your list on the <b>Stores</b> tab.</>}
        </div>}
      </div>
    </div> : <button onClick={openPicker} style={{ marginTop: 4, background: "none", border: "none", color: T.navy, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: "3px 0" }}>+ Add store</button>}
  </div>;
}

/* ---- Stores ---- */
/* Pick or drop a spreadsheet. The file is parsed SERVER-side (lib/sheet.js),
   so .xlsx, .xls and .csv all work and a title block above the headers is
   found rather than breaking the import. */
function FileDrop({ ui, file, onFile, hint, busy }) {
  const ref = useRef(null);
  const [over, setOver] = useState(false);
  function take(f) { if (f) onFile(f); }
  return <div
    onDragOver={(e) => { e.preventDefault(); setOver(true); }}
    onDragLeave={() => setOver(false)}
    onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files && e.dataTransfer.files[0]); }}
    onClick={() => !busy && ref.current && ref.current.click()}
    style={{ border: `2px dashed ${over ? T.navy : T.line}`, background: over ? T.navySoft : "#fff", borderRadius: 12, padding: "22px 16px", textAlign: "center", cursor: busy ? "default" : "pointer" }}>
    <input ref={ref} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }} onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; take(f); }} />
    <Icon ui={ui} name="Upload" size={24} color={T.navy} />
    <div style={{ fontFamily: ui.HEAD, fontWeight: 700, fontSize: 14.5, color: T.ink, marginTop: 8 }}>{file ? file.name : "Choose a spreadsheet"}</div>
    <div style={{ fontSize: 12.5, color: T.sub, marginTop: 3 }}>{file ? "Click to pick a different file" : (hint || "Excel or CSV — drag it here, or click to browse")}</div>
  </div>;
}

function StoresPanel({ ui, notify }) {
  const [stores, setStores] = useState(null);
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [file, setFile] = useState(null);
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  function reload() { jget(ui, "/api/stores?includeClosed=1&limit=500").then((r) => setStores((r && r.stores) || [])); }
  useEffect(reload, []);
  const ready = !!file || !!paste.trim();

  function pasteRows() { return paste.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split("\t")); }
  // force:true on a PREVIEW only skips the blast-radius refusal so the count of
  // what Replace WOULD close comes back; apply:false means nothing is written.
  async function send(opts) {
    setBusy(true);
    let r;
    if (file) {
      // Flags before the file: multer fills req.body as it streams, and a
      // field after the file is a classic way to read undefined on the server.
      const fd = new FormData();
      if (opts.apply) fd.append("apply", "1");
      if (opts.closeMissing) fd.append("closeMissing", "1");
      if (opts.force) fd.append("force", "1");
      fd.append("file", file);
      r = await jform(ui, "/api/stores/upload-file", fd);
    } else {
      r = await jpost(ui, "/api/stores/upload", { rows: pasteRows(), apply: !!opts.apply, closeMissing: !!opts.closeMissing, force: !!opts.force });
    }
    setBusy(false);
    return r;
  }
  async function onPick(f) {
    setFile(f); setPreview(null); setBusy(true);
    const fd = new FormData();
    fd.append("closeMissing", "1"); fd.append("force", "1"); fd.append("file", f);
    const r = await jform(ui, "/api/stores/upload-file", fd);
    setBusy(false); setPreview(r);
    if (r && r.error) notify(r.error, "error");
  }
  async function doPreview() { const r = await send({ closeMissing: true, force: true }); setPreview(r); if (r && r.error) notify(r.error, "error"); }
  async function doApply(closeMissing, force) {
    const r = await send({ apply: true, closeMissing, force });
    if (r && r.error && !r.preview) { notify(r.error, "error"); return; }
    if (r && r.error) { setPreview(r); return; }
    setPreview(null); setFile(null); setPaste("");
    notify(`${r.upserted} stores saved${r.closed ? `, ${r.closed} closed` : ""}`);
    reload();
  }
  const list = (stores || []).filter((s) => (showClosed || s.active) && (!q || String(s.name).toLowerCase().includes(q.toLowerCase()) || String(s.city || "").toLowerCase().includes(q.toLowerCase())));
  return <div>
    <PanelHead ui={ui} title="Stores" body="The stores a merchandiser can visit. Upload the spreadsheet straight from your export — it needs a header row with Name, and any of Address, City, State, Zip, Route, Chain, Store #. A title block above the headers is fine." />
    <div className="pf-2col">
      <Card>
        <H2 ui={ui} style={{ marginBottom: 10 }}>Upload</H2>
        <FileDrop ui={ui} file={file} busy={busy} onFile={onPick} />
        {busy && <div style={{ fontSize: 12.5, color: T.sub, marginTop: 8 }}>Reading…</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          {!file && <Btn ui={ui} kind="ghost" small onClick={doPreview} disabled={!ready || busy}>Preview</Btn>}
          <Btn ui={ui} small onClick={() => doApply(false)} disabled={!ready || busy}>Add / update</Btn>
          <Btn ui={ui} kind="danger" small onClick={() => doApply(true, false)} disabled={!ready || busy}>Replace list</Btn>
          {(file || paste) && <Btn ui={ui} kind="ghost" small onClick={() => { setFile(null); setPaste(""); setPreview(null); }} disabled={busy}>Clear</Btn>}
        </div>
        <div style={{ fontSize: 11.5, color: T.mute, marginTop: 8, lineHeight: 1.5 }}><b>Add / update</b> never closes a store. <b>Replace list</b> also closes active stores that aren't in the file (they keep their history).</div>
        {preview && preview.error && <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: T.redSoft, color: T.red, fontSize: 13 }}>
          {preview.error}{preview.preview && <div style={{ marginTop: 8 }}><Btn ui={ui} kind="danger" small onClick={() => doApply(true, true)}>Yes, close {preview.toClose} stores</Btn></div>}
        </div>}
        {preview && !preview.error && <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: T.navySoft, color: T.ink, fontSize: 13, lineHeight: 1.6 }}>
          <b>{preview.parsed}</b> stores read{preview.sheet ? <> from sheet <b>{preview.sheet}</b></> : null}.
          {preview.sheets && preview.sheets.length > 1 && <div style={{ color: T.sub, fontSize: 12 }}>That file has {preview.sheets.length} sheets; only the first is read.</div>}
          <div>{preview.willClose ? <>Replacing would close <b>{preview.willClose}</b> active store{preview.willClose === 1 ? "" : "s"}.</> : "Nothing would be closed."}</div>
        </div>}
        <button onClick={() => setShowPaste((v) => !v)} style={{ background: "none", border: "none", color: T.navy, fontSize: 12.5, fontWeight: 700, cursor: "pointer", padding: "10px 0 0" }}>{showPaste ? "Hide paste box" : "or paste rows instead"}</button>
        {showPaste && <textarea value={paste} onChange={(e) => { setPaste(e.target.value); setFile(null); setPreview(null); }} rows={7} placeholder={"Name\tAddress\tCity\tState\tZip\tRoute"} style={Object.assign({}, inputStyle, { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, resize: "vertical", marginTop: 8 })} />}
      </Card>
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <H2 ui={ui}>{stores ? `${list.length} store${list.length === 1 ? "" : "s"}` : "Stores"}</H2>
          <div style={{ flex: 1 }} />
          <label style={{ fontSize: 12.5, color: T.sub, display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> show closed</label>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" style={Object.assign({}, inputStyle, { width: 200, padding: "7px 10px", fontSize: 13 })} />
        </div>
        {stores && !stores.length && <Empty ui={ui} icon="MapPin" title="No stores yet" body="Upload your store spreadsheet on the left to get started." />}
        <div style={{ maxHeight: "70vh", overflowY: "auto" }}>
          {list.map((s) => <div key={s.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 90px 70px", gap: 10, padding: "8px 4px", borderTop: `1px solid ${T.line}`, fontSize: 13, color: s.active ? T.ink : T.mute, alignItems: "center" }}>
            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}{s.chain ? <span style={{ color: T.mute, fontWeight: 500 }}> · {s.chain}</span> : null}</div>
            <div style={{ color: T.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[s.addr, s.city].filter(Boolean).join(", ")}</div>
            <div style={{ color: T.sub }}>{s.route || ""}</div>
            <div>{s.active ? <Badge tone="green">Active</Badge> : <Badge>Closed</Badge>}</div>
          </div>)}
        </div>
      </Card>
    </div>
  </div>;
}

/* ---- Catalog & plans ---- */
function CatalogPanel({ ui, notify }) {
  const [products, setProducts] = useState(null);
  const [pq, setPq] = useState("");
  const [paste, setPaste] = useState("");
  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState("");
  const [plan, setPlan] = useState(null);
  const [sections, setSections] = useState([]);
  const [newSection, setNewSection] = useState("");
  const [form, setForm] = useState({ aisle: "", bay: "", shelf: "", sectionId: "", note: "" });
  const [copyFrom, setCopyFrom] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [prodFile, setProdFile] = useState(null);
  const [prodBusy, setProdBusy] = useState(false);
  const [showProdPaste, setShowProdPaste] = useState(false);
  const [catFilter, setCatFilter] = useState("");
  const [picked, setPicked] = useState(new Set());
  const [prodPreview, setProdPreview] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [bulk, setBulk] = useState({ aisle: "", bay: "", shelf: "", sectionId: "", note: "" });
  const [planQ, setPlanQ] = useState("");
  const [planCat, setPlanCat] = useState("");
  const [planSel, setPlanSel] = useState(new Set());

  function loadProducts() { jget(ui, "/api/products?limit=500").then((r) => setProducts((r && r.products) || [])); }
  function loadPlan(id) {
    if (!id) return;
    jget(ui, "/api/stores/" + encodeURIComponent(id) + "/plan").then(setPlan);
    jget(ui, "/api/stores/" + encodeURIComponent(id) + "/sections").then((r) => setSections((r && r.sections) || []));
  }
  useEffect(() => { loadProducts(); jget(ui, "/api/stores?limit=500").then((r) => setStores((r && r.stores) || [])); }, []);
  useEffect(() => { setPlan(null); setSections([]); loadPlan(storeId); }, [storeId]);

  function savedMsg(r) {
    return `${r.saved} product${r.saved === 1 ? "" : "s"} saved` +
      (r.closed ? `, ${r.closed} retired` : "") + (r.skipped ? `, ${r.skipped} skipped` : "");
  }
  function pasteRows() { return paste.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split("\t")); }
  /* Picking a file PREVIEWS it -- nothing is written until Add or Replace is
     pressed. A wrong file (a store list pasted into the catalog, say) should
     be caught on screen, not discovered afterwards in the product list. */
  async function sendProducts(opts) {
    setProdBusy(true);
    let r;
    if (prodFile) {
      const fd = new FormData();
      if (opts.apply) fd.append("apply", "1");
      if (opts.replace) fd.append("replace", "1");
      fd.append("file", prodFile);
      r = await jform(ui, "/api/products/upload-file", fd);
    } else {
      r = await jpost(ui, "/api/products", { rows: pasteRows(), apply: !!opts.apply, replace: !!opts.replace });
    }
    setProdBusy(false);
    return r;
  }
  async function pickProductFile(f) {
    setProdFile(f); setProdPreview(null); setProdBusy(true);
    const fd = new FormData();
    fd.append("replace", "1"); fd.append("file", f); // preview only: apply is absent, so nothing is written
    const r = await jform(ui, "/api/products/upload-file", fd);
    setProdBusy(false);
    if (r && r.error) { notify(r.error, "error"); return; }
    setProdPreview(r);
  }
  async function applyProducts(replace) {
    const r = await sendProducts({ apply: true, replace });
    if (!r || r.error) return notify((r && r.error) || "Couldn't save", "error");
    setPaste(""); setProdFile(null); setProdPreview(null);
    notify(savedMsg(r) + (r.sheet ? ` from ${r.sheet}` : "")); loadProducts(); loadPlan(storeId);
  }
  async function clearProducts() {
    const r = await jpost(ui, "/api/products/clear", {});
    if (!r || r.error) return notify((r && r.error) || "Couldn't clear", "error");
    notify(`Cleared ${r.products} product${r.products === 1 ? "" : "s"}${r.planItems ? ` and ${r.planItems} plan row${r.planItems === 1 ? "" : "s"}` : ""}`);
    setPicked(new Set()); loadProducts(); loadPlan(storeId);
  }
  function togglePlanSel(id) { setPlanSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  async function addPlanPicked() {
    if (!storeId || !planSel.size) return notify("Pick a product first", "error");
    const r = await jpost(ui, "/api/stores/" + encodeURIComponent(storeId) + "/plan",
      { productIds: [...planSel], aisle: form.aisle, bay: form.bay, shelf: form.shelf, sectionId: form.sectionId || null, note: form.note });
    if (!r || r.error) return notify((r && r.error) || "Couldn't save", "error");
    notify(`${r.added} added${r.skipped ? `, ${r.skipped} already there` : ""}`);
    setPlanSel(new Set()); setPlanQ("");
    setForm((f) => ({ ...f, bay: "", shelf: "", note: "" })); // keep aisle/section: the next run is usually the same spot
    loadPlan(storeId);
  }
  async function addSection() {
    if (!newSection.trim()) return;
    await jpost(ui, "/api/stores/" + encodeURIComponent(storeId) + "/sections", { label: newSection.trim(), ord: sections.length });
    setNewSection(""); notify("Section added"); loadPlan(storeId);
  }
  const visible = (products || []).filter((p) => {
    if (pq && !(String(p.name).toLowerCase().includes(pq.toLowerCase()) || String(p.brand || "").toLowerCase().includes(pq.toLowerCase()) || String(p.itemNo || "").includes(pq))) return false;
    if (catFilter === "none") return !p.category;
    if (catFilter) return p.category === catFilter;
    return true;
  });
  const storeName = (id) => { const s = stores.find((x) => x.id === id); return s ? s.name : id; };
  // Products already on this store's plan, so the picker can say so instead
  // of letting someone add a duplicate and wonder why nothing happened.
  const onPlan = useMemo(() => new Set(((plan && plan.groups) || []).flatMap((g) => g.items.map((i) => i.productId))), [plan]);
  const planPick = useMemo(() => (products || []).filter((p) => {
    if (planCat && p.category !== planCat) return false;
    if (!planQ) return true;
    const q = planQ.toLowerCase();
    return String(p.name).toLowerCase().includes(q) || String(p.brand || "").toLowerCase().includes(q) || String(p.itemNo || "").includes(q);
  }).slice(0, 80), [products, planQ, planCat]);
  function togglePick(id) { setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  async function addPicked() {
    const r = await jpost(ui, "/api/stores/" + encodeURIComponent(storeId) + "/plan", Object.assign({ productIds: [...picked] }, bulk, { sectionId: bulk.sectionId || null }));
    if (!r || r.error) return notify((r && r.error) || "Couldn't add those", "error");
    notify(`${r.added} added to ${storeName(storeId)}${r.skipped ? `, ${r.skipped} already there` : ""}`);
    setPicked(new Set());
    loadPlan(storeId);
  }
  async function setCategory(category) {
    const ids = [...picked];
    const r = await jpost(ui, "/api/products/category", { ids, category });
    if (!r || r.error) return notify((r && r.error) || "Couldn't set that", "error");
    setPicked(new Set());
    notify(`${r.updated} product${r.updated === 1 ? "" : "s"} marked ${category === "beer" ? "Beer" : "Non-alc"}`);
    loadProducts();
  }

  return <div>
    <PanelHead ui={ui} title="Catalog & store plans" body="Products are the branch's catalog. A store plan is what a merchandiser checks off in that store — each row is a product and where it lives (aisle / bay / shelf). Sections are optional groupings like Cooler or Beer Cave; they're what time gets measured against." />
    <div className="pf-2col">
      <Card>
        <H2 ui={ui} style={{ marginBottom: 10 }}>Products {products ? <span style={{ color: T.mute, fontWeight: 600 }}>({products.length})</span> : null}</H2>
        <FileDrop ui={ui} file={prodFile} busy={prodBusy} onFile={pickProductFile} hint="Excel or CSV — Name, Item #, Brand, Pack, Category" />
        {prodBusy && <div style={{ fontSize: 12.5, color: T.sub, marginTop: 8 }}>Reading…</div>}
        {prodPreview && <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: T.navySoft, color: T.ink, fontSize: 13, lineHeight: 1.6 }}>
          <b>{prodPreview.parsed}</b> product{prodPreview.parsed === 1 ? "" : "s"} read{prodPreview.sheet ? <> from sheet <b>{prodPreview.sheet}</b></> : null}{prodPreview.skipped ? <>, {prodPreview.skipped} row{prodPreview.skipped === 1 ? "" : "s"} without a name skipped</> : null}.
          {prodPreview.categorised > 0 && <div>{prodPreview.categorised} carry a category.</div>}
          {prodPreview.sample && prodPreview.sample.length > 0 && <div style={{ color: T.sub, fontSize: 12, marginTop: 4 }}>First rows: {prodPreview.sample.map((s) => s.name).join(", ")}</div>}
          {prodPreview.willClose > 0 && <div style={{ marginTop: 4 }}>Replacing would retire <b>{prodPreview.willClose}</b> product{prodPreview.willClose === 1 ? "" : "s"} not in this file.</div>}
        </div>}
        {(prodFile || paste.trim()) && <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <Btn ui={ui} small onClick={() => applyProducts(false)} disabled={prodBusy}>Add / update</Btn>
          <Btn ui={ui} small kind="danger" onClick={() => applyProducts(true)} disabled={prodBusy}>Replace catalog</Btn>
          <Btn ui={ui} small kind="ghost" onClick={() => { setProdFile(null); setPaste(""); setProdPreview(null); }} disabled={prodBusy}>Clear</Btn>
        </div>}
        <div style={{ fontSize: 11.5, color: T.mute, marginTop: 8, lineHeight: 1.5 }}><b>Add / update</b> only adds and edits. <b>Replace catalog</b> also retires products that aren't in the file, and takes their store-plan rows with them.</div>
        <button onClick={() => setShowProdPaste((v) => !v)} style={{ background: "none", border: "none", color: T.navy, fontSize: 12.5, fontWeight: 700, cursor: "pointer", padding: "10px 0 0" }}>{showProdPaste ? "Hide paste box" : "or paste rows instead"}</button>
        {showProdPaste && <textarea value={paste} onChange={(e) => { setPaste(e.target.value); setProdFile(null); setProdPreview(null); }} rows={4} placeholder={"Name\tItem #\tBrand\tPack"} style={Object.assign({}, inputStyle, { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, resize: "vertical", marginTop: 8 })} />}
        <input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Search name or brand…" style={Object.assign({}, inputStyle, { marginTop: 14, padding: "7px 10px", fontSize: 13 })} />
        {/* Categorising the catalog is what makes beer-vs-NA measurable, and
            no export arrives with our own split -- so it is a multi-select
            plus one button rather than editing products one at a time. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          {[["", "All"], ["beer", "Beer"], ["na", "Non-alc"], ["none", "Uncategorised"]].map(([v, label]) => (
            <button key={v || "all"} onClick={() => setCatFilter(v)} style={{ padding: "4px 10px", borderRadius: 999, border: `1px solid ${catFilter === v ? T.navy : T.line}`, background: catFilter === v ? T.navySoft : "#fff", color: catFilter === v ? T.navy : T.sub, fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>{label}</button>
          ))}
          <div style={{ flex: 1 }} />
          {picked.size > 0 && <>
            <span style={{ fontSize: 12, color: T.sub }}>{picked.size} picked</span>
            <Btn ui={ui} small onClick={() => setCategory("beer")}>Mark Beer</Btn>
            <Btn ui={ui} small kind="ghost" onClick={() => setCategory("na")}>Mark Non-alc</Btn>
          </>}
        </div>
        <div style={{ maxHeight: 420, overflowY: "auto", marginTop: 6 }}>
          {products && !products.length && <Empty ui={ui} icon="ClipboardList" title="No products yet" body="Upload the catalog above." />}
          {products && products.length > 0 && !visible.length && <div style={{ fontSize: 12.5, color: T.mute, padding: "10px 2px" }}>Nothing here.</div>}
          {visible.length > 0 && <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", fontSize: 11.5, color: T.mute }}>
            <input type="checkbox" checked={picked.size > 0 && visible.every((p) => picked.has(p.id))} onChange={(e) => setPicked(e.target.checked ? new Set(visible.map((p) => p.id)) : new Set())} />
            <span>select all {visible.length} shown</span>
          </div>}
          {visible.map((p) => <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 2px", borderTop: `1px solid ${T.line}`, fontSize: 13 }}>
            <input type="checkbox" checked={picked.has(p.id)} onChange={() => togglePick(p.id)} />
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, color: T.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div><div style={{ fontSize: 11.5, color: T.mute }}>{[p.itemNo && "#" + p.itemNo, p.brand, p.pack].filter(Boolean).join(" · ")}</div></div>
            {p.category ? <Badge tone={p.category === "beer" ? "navy" : "green"}>{p.category === "beer" ? "Beer" : "Non-alc"}</Badge> : <Badge tone="amber">Uncategorised</Badge>}
            <button onClick={() => setConfirm({ title: `Remove ${p.name}?`, body: "It comes off every store plan too.", run: () => jpost(ui, "/api/products/" + encodeURIComponent(p.id) + "/remove", {}).then(() => { notify("Product removed"); loadProducts(); loadPlan(storeId); }) })} aria-label="Remove" style={{ background: "none", border: "none", cursor: "pointer", padding: 4, lineHeight: 0 }}><Icon ui={ui} name="Trash2" size={14} color={T.mute} /></button>
          </div>)}
        </div>
        {products && products.length > 0 && <div style={{ borderTop: `1px solid ${T.line}`, marginTop: 10, paddingTop: 10 }}>
          <button onClick={() => setConfirmClear(true)} style={{ background: "none", border: "none", color: T.red, fontSize: 12.5, fontWeight: 700, cursor: "pointer", padding: 0 }}>Clear the whole catalog</button>
        </div>}
      </Card>
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <H2 ui={ui}>Store plan</H2>
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)} style={Object.assign({}, inputStyle, { width: 320, padding: "7px 10px", fontSize: 13 })}>
            <option value="">Choose a store…</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.city ? ` — ${s.city}` : ""}</option>)}
          </select>
          {storeId && plan && <span style={{ fontSize: 13, color: T.sub }}>{plan.count} item{plan.count === 1 ? "" : "s"}</span>}
        </div>
        {/* The bridge from the product list to the plan. Appears the moment
            anything is ticked on the left, because "I selected them, now
            what" was the actual dead end. */}
        {picked.size > 0 && <div style={{ background: T.navySoft, border: `1.5px solid ${T.navy}`, borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <div style={{ fontFamily: ui.HEAD, fontWeight: 700, fontSize: 14, color: T.ink, marginBottom: 8 }}>
            {picked.size} product{picked.size === 1 ? "" : "s"} selected{storeId ? <> — add to <b>{storeName(storeId)}</b></> : null}
          </div>
          {!storeId ? <div style={{ fontSize: 13, color: T.sub }}>Choose a store above first.</div> : <>
            <div style={{ display: "grid", gridTemplateColumns: "70px 70px 70px 1fr 1fr auto", gap: 6, alignItems: "end" }}>
              <Field label="Aisle"><input value={bulk.aisle} onChange={(e) => setBulk({ ...bulk, aisle: e.target.value })} placeholder="Beer" style={inputStyle} /></Field>
              <Field label="Bay"><input value={bulk.bay} onChange={(e) => setBulk({ ...bulk, bay: e.target.value })} style={inputStyle} /></Field>
              <Field label="Shelf"><input value={bulk.shelf} onChange={(e) => setBulk({ ...bulk, shelf: e.target.value })} style={inputStyle} /></Field>
              <Field label="Section"><select value={bulk.sectionId} onChange={(e) => setBulk({ ...bulk, sectionId: e.target.value })} style={inputStyle}><option value="">—</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
              <Field label="Note"><input value={bulk.note} onChange={(e) => setBulk({ ...bulk, note: e.target.value })} placeholder="optional" style={inputStyle} /></Field>
              <Btn ui={ui} small onClick={addPicked} style={{ height: 40 }}>Add {picked.size}</Btn>
            </div>
            <div style={{ fontSize: 11.5, color: T.sub, marginTop: 8, lineHeight: 1.5 }}>
              They all go to the same spot — which is right for a beer aisle. Leave Aisle blank if this store's beer isn't numbered; the section name carries it. Anything already on the plan at that spot is skipped, not duplicated.
            </div>
          </>}
        </div>}
        {!storeId && <Empty ui={ui} icon="MapPin" title="Pick a store" body="Then add the products a merchandiser should check there." />}
        {storeId && <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: T.sub }}>Sections:</span>
            {sections.map((s) => <Chip key={s.id} small label={s.label} onRemove={() => setConfirm({ title: `Remove section ${s.label}?`, body: "Items in it stay on the plan.", run: () => jpost(ui, "/api/sections/" + s.id + "/remove", {}).then(() => { notify("Section removed"); loadPlan(storeId); }) })} />)}
            <input value={newSection} onChange={(e) => setNewSection(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addSection(); }} placeholder="+ e.g. Cooler" style={Object.assign({}, inputStyle, { width: 130, padding: "4px 8px", fontSize: 12 })} />
          </div>
          {/* Type to filter, tick what you want, add them all at one spot.
              This replaced a 497-option <select> with no search, which is an
              unusable control standing in a store -- which is where this
              screen is actually used. */}
          <div style={{ padding: 12, background: T.panel, borderRadius: 12, marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
              <input autoFocus value={planQ} onChange={(e) => setPlanQ(e.target.value)} placeholder="Type a product or brand…" style={Object.assign({}, inputStyle, { flex: 1, minWidth: 200 })} />
              {[["", "All"], ["beer", "Beer"], ["na", "Non-alc"]].map(([v, label]) => (
                <button key={v || "all"} onClick={() => setPlanCat(v)} style={{ padding: "6px 12px", borderRadius: 999, border: `1px solid ${planCat === v ? T.navy : T.line}`, background: planCat === v ? T.navySoft : "#fff", color: planCat === v ? T.navy : T.sub, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{label}</button>
              ))}
            </div>
            <div style={{ maxHeight: 210, overflowY: "auto", background: "#fff", border: `1px solid ${T.line}`, borderRadius: 10 }}>
              {!planPick.length && <div style={{ fontSize: 12.5, color: T.mute, padding: "10px 12px" }}>{products && products.length ? "Nothing matches that." : "No products in the catalog yet."}</div>}
              {planPick.map((p) => {
                const on = planSel.has(p.id);
                const already = onPlan.has(p.id);
                return <div key={p.id} onClick={() => togglePlanSel(p.id)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: `1px solid ${T.line}`, cursor: "pointer", background: on ? T.navySoft : "#fff" }}>
                  <input type="checkbox" checked={on} readOnly />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: T.ink, fontSize: 13.5 }}>{p.name}</div>
                    <div style={{ fontSize: 11.5, color: T.mute }}>{[p.itemNo && "#" + p.itemNo, p.brand].filter(Boolean).join(" · ")}</div>
                  </div>
                  {already && <Badge tone="gray">on plan</Badge>}
                  {p.category && <Badge tone={p.category === "beer" ? "navy" : "green"}>{p.category === "beer" ? "Beer" : "Non-alc"}</Badge>}
                </div>;
              })}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "80px 80px 80px 1fr 1fr auto", gap: 6, alignItems: "end", marginTop: 10 }}>
              <Field label="Aisle"><input value={form.aisle} onChange={(e) => setForm({ ...form, aisle: e.target.value })} placeholder="Beer" style={inputStyle} /></Field>
              <Field label="Bay"><input value={form.bay} onChange={(e) => setForm({ ...form, bay: e.target.value })} style={inputStyle} /></Field>
              <Field label="Shelf"><input value={form.shelf} onChange={(e) => setForm({ ...form, shelf: e.target.value })} style={inputStyle} /></Field>
              <Field label="Section"><select value={form.sectionId} onChange={(e) => setForm({ ...form, sectionId: e.target.value })} style={inputStyle}><option value="">—</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
              <Field label="Note"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. endcap" style={inputStyle} /></Field>
              <Btn ui={ui} small onClick={addPlanPicked} disabled={!planSel.size} style={{ height: 40 }}>Add {planSel.size || ""}</Btn>
            </div>
            {planSel.size > 0 && <div style={{ fontSize: 11.5, color: T.sub, marginTop: 8 }}>
              {planSel.size} selected — they all land at the same spot. Leave <b>Aisle</b> blank if the beer aisle isn't numbered; the section name carries it.
              <button onClick={() => setPlanSel(new Set())} style={{ background: "none", border: "none", color: T.navy, fontWeight: 700, cursor: "pointer", fontSize: 11.5 }}>clear</button>
            </div>}
          </div>
          {plan && !plan.count && <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 12, border: `1px dashed ${T.line}`, borderRadius: 12 }}>
            <div style={{ flex: 1, fontSize: 13, color: T.sub }}>Nothing mapped yet. Start from a sibling store's plan?</div>
            <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} style={Object.assign({}, inputStyle, { width: 240, padding: "6px 8px", fontSize: 13 })}><option value="">Copy from…</option>{stores.filter((s) => s.id !== storeId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <Btn ui={ui} small kind="ghost" disabled={!copyFrom} onClick={() => jpost(ui, "/api/stores/" + encodeURIComponent(storeId) + "/plan", { copyFrom }).then((r) => { notify(`Copied ${r.copied} items from ${storeName(copyFrom)}`); loadPlan(storeId); })}>Copy</Btn>
          </div>}
          {plan && (plan.groups || []).map((g) => <div key={g.aisle} style={{ marginBottom: 10 }}>
            <Eyebrow ui={ui} style={{ marginBottom: 2 }}>Aisle {g.aisle}</Eyebrow>
            {g.items.map((it) => <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 2px", borderTop: `1px solid ${T.line}`, fontSize: 13 }}>
              <div style={{ flex: 1, fontWeight: 600, color: T.ink }}>{it.name}{it.itemNo ? <span style={{ color: T.mute, fontWeight: 500 }}> #{it.itemNo}</span> : null}</div>
              <div style={{ color: T.sub, fontSize: 12.5 }}>{[it.bay && "Bay " + it.bay, it.shelf && "Shelf " + it.shelf, it.note].filter(Boolean).join(" · ")}</div>
              {it.sectionLabel && <Badge tone="navy">{it.sectionLabel}</Badge>}
              <button onClick={() => jpost(ui, "/api/stores/" + encodeURIComponent(storeId) + "/plan", { remove: true, id: it.id }).then(() => { notify("Removed"); loadPlan(storeId); })} aria-label="Remove" style={{ background: "none", border: "none", cursor: "pointer", padding: 4, lineHeight: 0 }}><Icon ui={ui} name="Trash2" size={13} color={T.mute} /></button>
            </div>)}
          </div>)}
        </>}
      </Card>
    </div>
    {confirm && <Sheet ui={ui} title={confirm.title} body={confirm.body} confirmLabel="Remove" confirmKind="danger" onCancel={() => setConfirm(null)} onConfirm={() => { confirm.run(); setConfirm(null); }} />}
    {confirmClear && <Sheet ui={ui} title={`Clear all ${(products || []).length} products?`}
      body="Every product is retired and every store plan row goes with it. Visits already recorded keep their history. You'd upload a fresh catalog afterwards."
      confirmLabel="Clear the catalog" confirmKind="danger"
      onCancel={() => setConfirmClear(false)} onConfirm={() => { clearProducts(); setConfirmClear(false); }} />}
  </div>;
}

/* ---- Team ---- */
function TeamPanel({ ui, notify }) {
  const [people, setPeople] = useState(null);
  const [teams, setTeams] = useState([]);
  const [form, setForm] = useState({ name: "", role: "merch", pin: "" });
  const [teamForm, setTeamForm] = useState({ name: "", color: "slate" });
  const [pinFor, setPinFor] = useState(null); const [newPin, setNewPin] = useState("");
  const [confirm, setConfirm] = useState(null);
  function reload() { jget(ui, "/api/people").then((r) => setPeople((r && r.people) || [])); jget(ui, "/api/teams").then((r) => setTeams((r && r.teams) || [])); }
  useEffect(reload, []);
  async function addPerson() {
    const r = await jpost(ui, "/api/people", form);
    if (!r || r.error) return notify((r && r.error) || "Couldn't add", "error");
    setForm({ name: "", role: "merch", pin: "" }); notify(`${form.name} added — they can sign in with that PIN`); reload();
  }
  async function savePin() {
    const r = await jpost(ui, "/api/people/" + encodeURIComponent(pinFor.id) + "/pin", { pin: newPin });
    if (!r || r.error) return notify((r && r.error) || "PIN must be 4-6 digits", "error");
    notify(`PIN reset for ${pinFor.name}`); setPinFor(null); setNewPin(""); reload();
  }
  async function addTeam() {
    if (!teamForm.name.trim()) return;
    await jpost(ui, "/api/teams", teamForm); setTeamForm({ name: "", color: "slate" }); notify("Team added"); reload();
  }
  const pinOk = /^\d{4,6}$/.test(form.pin);
  return <div>
    <PanelHead ui={ui} title="Team" body="Merchandisers sign in to Proof with a PIN. Put each one on a team, and the weekly schedule follows the team. Admins run this screen." />
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 18, alignItems: "start" }}>
      <Card>
        <H2 ui={ui} style={{ marginBottom: 10 }}>People</H2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 150px 110px auto", gap: 8, alignItems: "end", padding: 12, background: T.panel, borderRadius: 12, marginBottom: 12 }}>
          <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="First Last" style={inputStyle} /></Field>
          <Field label="Role"><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={inputStyle}><option value="merch">Merchandiser</option><option value="admin">Admin</option></select></Field>
          <Field label="PIN (4-6 digits)"><input value={form.pin} inputMode="numeric" onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "").slice(0, 6) })} style={inputStyle} /></Field>
          <Btn ui={ui} small onClick={addPerson} disabled={!form.name.trim() || !pinOk} style={{ height: 40 }}>Add</Btn>
        </div>
        {people && !people.length && <Empty ui={ui} icon="Users" title="Nobody yet" body="Add your first merchandiser above." />}
        {(people || []).map((p) => <div key={p.id} style={{ display: "grid", gridTemplateColumns: "1fr 110px 170px 90px 120px", gap: 10, alignItems: "center", padding: "10px 4px", borderTop: `1px solid ${T.line}`, fontSize: 13.5, opacity: p.active ? 1 : 0.55 }}>
          <div>
            <div style={{ fontWeight: 700, color: T.ink }}>{p.name} {p.locked && <Badge tone="red">Locked</Badge>}</div>
            <div style={{ fontSize: 11.5, color: T.mute }}>{p.devices} device{p.devices === 1 ? "" : "s"}{!p.hasPin ? " · no PIN" : ""}</div>
          </div>
          <div>{p.role === "admin" ? <Badge tone="navy">Admin</Badge> : <Badge>Merchandiser</Badge>}</div>
          <select value={p.teamId || ""} disabled={p.role === "admin"} onChange={(e) => jpost(ui, "/api/people/" + encodeURIComponent(p.id) + "/team", { teamId: e.target.value || null }).then(() => { notify("Team updated"); reload(); })} style={Object.assign({}, inputStyle, { padding: "6px 8px", fontSize: 13 })}>
            <option value="">No team</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button onClick={() => { setPinFor(p); setNewPin(""); }} style={{ background: "none", border: `1px solid ${T.line}`, borderRadius: 8, padding: "6px 8px", fontSize: 12, fontWeight: 600, color: T.navy, cursor: "pointer" }}>{p.locked ? "Unlock" : "Reset PIN"}</button>
          <button onClick={() => p.active ? setConfirm({ title: `Deactivate ${p.name}?`, body: "They're signed out everywhere and can't sign back in. Their history stays.", run: () => jpost(ui, "/api/people/" + encodeURIComponent(p.id) + "/active", { active: false }).then(() => { notify("Deactivated"); reload(); }) }) : jpost(ui, "/api/people/" + encodeURIComponent(p.id) + "/active", { active: true }).then(() => { notify("Reactivated"); reload(); })}
            style={{ background: "none", border: `1px solid ${p.active ? T.line : T.green}`, borderRadius: 8, padding: "6px 8px", fontSize: 12, fontWeight: 600, color: p.active ? T.sub : T.green, cursor: "pointer" }}>{p.active ? "Deactivate" : "Reactivate"}</button>
        </div>)}
      </Card>
      <Card>
        <H2 ui={ui} style={{ marginBottom: 10 }}>Teams</H2>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <input value={teamForm.name} onChange={(e) => setTeamForm({ ...teamForm, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") addTeam(); }} placeholder="Team name" style={inputStyle} />
          <Btn ui={ui} small onClick={addTeam} disabled={!teamForm.name.trim()}>Add</Btn>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>{Object.keys(TEAM_HEX).map((c) => <button key={c} onClick={() => setTeamForm({ ...teamForm, color: c })} aria-label={c} style={{ width: 22, height: 22, borderRadius: 999, background: TEAM_HEX[c], border: `3px solid ${teamForm.color === c ? T.ink : "#fff"}`, boxShadow: `0 0 0 1px ${T.line}`, cursor: "pointer" }} />)}</div>
        {!teams.length && <div style={{ fontSize: 13, color: T.mute }}>No teams yet.</div>}
        {teams.map((t) => <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 2px", borderTop: `1px solid ${T.line}` }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: TEAM_HEX[t.color] || TEAM_HEX.slate }} />
          <span style={{ flex: 1, fontWeight: 600, color: T.ink, fontSize: 13.5 }}>{t.name}</span>
          <span style={{ fontSize: 12, color: T.mute }}>{(people || []).filter((p) => p.teamId === t.id && p.active).length} people</span>
          <button onClick={() => setConfirm({ title: `Remove ${t.name}?`, body: "Its people become unassigned and it comes off every block.", run: () => jpost(ui, "/api/teams/" + encodeURIComponent(t.id) + "/remove", {}).then(() => { notify("Team removed"); reload(); }) })} aria-label="Remove" style={{ background: "none", border: "none", cursor: "pointer", padding: 4, lineHeight: 0 }}><Icon ui={ui} name="Trash2" size={14} color={T.mute} /></button>
        </div>)}
      </Card>
    </div>
    {pinFor && <Sheet ui={ui} title={`Reset PIN for ${pinFor.name}`} body="Read them the new number. Resetting also clears a lockout." confirmLabel="Save PIN" onCancel={() => setPinFor(null)} onConfirm={savePin}>
      <input autoFocus value={newPin} inputMode="numeric" onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="4-6 digits" style={Object.assign({}, inputStyle, { marginTop: 14, fontSize: 22, letterSpacing: 6, textAlign: "center" })} />
    </Sheet>}
    {confirm && <Sheet ui={ui} title={confirm.title} body={confirm.body} confirmLabel="Confirm" confirmKind="danger" onCancel={() => setConfirm(null)} onConfirm={() => { confirm.run(); setConfirm(null); }} />}
  </div>;
}

/* ---- Devices ---- */
function DevicesPanel({ ui, notify }) {
  const [pending, setPending] = useState(null);
  function reload() { jget(ui, "/api/devices/pending").then((r) => setPending((r && r.pending) || [])); }
  useEffect(reload, []);
  return <div>
    <PanelHead ui={ui} title="Devices" body="The first phone someone signs in on is theirs automatically. A second phone waits here until you approve it — that's what stops a PIN from being shared around. Approving is one click." />
    <Card>
      {pending && !pending.length && <Empty ui={ui} icon="ShieldCheck" title="Nothing waiting" body="New devices show up here the moment someone tries to sign in from one." />}
      {(pending || []).map((d) => <div key={d.merch_id + d.device_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 4px", borderTop: `1px solid ${T.line}` }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: T.amberSoft, display: "grid", placeItems: "center" }}><Icon ui={ui} name="AlertTriangle" size={18} color={T.amber} /></div>
        <div style={{ flex: 1 }}><div style={{ fontWeight: 700, color: T.ink }}>{d.name}</div><div style={{ fontSize: 12.5, color: T.sub }}>New device · first seen {new Date(d.first_seen).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div></div>
        <Btn ui={ui} small kind="green" onClick={() => jpost(ui, "/api/devices/" + encodeURIComponent(d.merch_id) + "/" + encodeURIComponent(d.device_id) + "/approve", {}).then(() => { notify(`Approved ${d.name}'s device`); reload(); })}>Approve</Btn>
        <Btn ui={ui} small kind="danger" onClick={() => jpost(ui, "/api/devices/" + encodeURIComponent(d.merch_id) + "/" + encodeURIComponent(d.device_id) + "/revoke", {}).then(() => { notify("Device blocked"); reload(); })}>Block</Btn>
      </div>)}
    </Card>
  </div>;
}

/* ---- One visit, as a manager sees it: how long, what they marked, the
   photos. Opened from Live (and later from Reporting). ---- */
function secs(n) {
  if (n == null) return "—";
  if (n < 90) return n + "s";
  const m = Math.round(n / 60);
  return m < 60 ? m + " min" : Math.floor(m / 60) + "h " + (m % 60) + "m";
}
// Photos fold into one row per (brand, place) -- the same unit the walk
// asked for them in, so the manager reads them the way they were taken.
function photosByBrand(photos) {
  const by = new Map();
  (photos || []).forEach((p) => {
    const key = (p.brand || "").toLowerCase() + "|" + (p.aisle || "") + "|" + (p.sectionId || "");
    if (!by.has(key)) by.set(key, { key, brand: p.brand || "", where: [p.aisle && "Aisle " + p.aisle, p.section].filter(Boolean).join(" · "), photos: [] });
    by.get(key).photos.push(p);
  });
  return [...by.values()];
}
const STATUS_TONE = { stocked: "green", fixed: "green", out_of_stock: "red", not_carried: "gray" };
const STATUS_LABEL = { stocked: "Stocked", fixed: "Fixed", out_of_stock: "Out of stock", not_carried: "Not carried" };

function VisitDetail({ ui, visitId, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [zoom, setZoom] = useState(null);
  useEffect(() => {
    jget(ui, "/api/visits/" + visitId).then((r) => { if (r && r.error) setErr(r.error); else setD(r); });
  }, [visitId]);

  const v = d && d.visit;
  const byBrand = useMemo(() => {
    if (!d) return [];
    const m = {};
    d.items.forEach((it) => {
      const k = it.brand || "(no brand)";
      (m[k] = m[k] || { brand: k, items: 0, seconds: 0 }).items++;
      m[k].seconds += it.estSeconds || 0;
    });
    return Object.values(m).sort((a, b) => b.seconds - a.seconds);
  }, [d]);

  return <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(14,31,60,0.5)", zIndex: 60, display: "flex", justifyContent: "flex-end" }}>
    <div onClick={(e) => e.stopPropagation()} style={{ background: T.panel, width: "min(760px, 100%)", height: "100%", overflowY: "auto", boxShadow: "-8px 0 30px rgba(0,0,0,0.2)" }}>
      <div style={{ background: T.navy, padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 2 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: ui.HEAD, fontWeight: 700, fontSize: 18, color: "#fff" }}>{v ? v.storeName : "Visit"}</div>
          {v && <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 12.5 }}>{v.merchName} · {fmtTime(v.startedAt)}{v.endedAt ? " – " + fmtTime(v.endedAt) : ""}</div>}
        </div>
        <button onClick={onClose} style={{ background: "rgba(255,255,255,0.14)", border: "none", color: "#fff", borderRadius: 8, padding: "7px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Close</button>
      </div>
      <div style={{ padding: 18 }}>
        {err && <Card accent={T.red}><div style={{ color: T.red, fontSize: 13.5 }}>{err}</div></Card>}
        {!d && !err && <div style={{ color: T.mute, padding: 20 }}>Loading…</div>}
        {d && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
            {[[v.minutes == null ? "—" : v.minutes + " min", "in store"], [d.items.length, "items marked"], [d.photos.length, "photos"], [v.closeReason === "manual" ? "Finished" : v.endedAt ? "Auto-closed" : "Open", "status"]].map(([a, b]) => (
              <Card key={b} pad={12} style={{ marginBottom: 0 }}>
                <div style={{ fontFamily: ui.HEAD, fontWeight: 800, fontSize: 19, color: T.ink }}>{a}</div>
                <div style={{ fontSize: 11.5, color: T.sub }}>{b}</div>
              </Card>
            ))}
          </div>
          {v.closeReason && v.closeReason !== "manual" && <Card accent={T.amber} style={{ background: T.amberSoft, borderColor: "#F1DDA6" }}>
            <div style={{ fontSize: 13, color: T.ink }}>This visit was closed {v.closeReason === "forgotten" ? "by the merchandiser from somewhere else" : "automatically overnight"}, so its length is a known unknown and it's left out of reporting averages by default.</div>
          </Card>}

          <Card>
            <H2 ui={ui} style={{ marginBottom: 8 }}>Photos</H2>
            {!d.photos.length && <div style={{ fontSize: 13, color: T.mute }}>No photos on this visit.</div>}
            {/* Grouped by brand, because that is what a photo covers now --
                and a brand with several is the Liquid Death case, not a
                duplicate. */}
            {photosByBrand(d.photos).map((grp) => (
              <div key={grp.key} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: T.ink, marginBottom: 6 }}>
                  {grp.brand || "Unlabelled"}
                  <span style={{ color: T.mute, fontWeight: 500 }}>{grp.where ? " · " + grp.where : ""} · {grp.photos.length} photo{grp.photos.length === 1 ? "" : "s"}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
                  {grp.photos.map((p) => (
                    <button key={p.id} onClick={() => setZoom(p)} style={{ padding: 0, border: `1px solid ${T.line}`, borderRadius: 10, overflow: "hidden", background: "#fff", cursor: "zoom-in" }}>
                      <img src={"/api/photos/" + p.id} alt="" loading="lazy" style={{ display: "block", width: "100%", height: 130, objectFit: "cover" }} />
                      <div style={{ fontSize: 11, color: T.sub, padding: "5px 7px", textAlign: "left" }}>{fmtTime(p.takenAt)}</div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </Card>

          {d.sections.length > 0 && <Card>
            <H2 ui={ui} style={{ marginBottom: 8 }}>Time by section</H2>
            {d.sections.map((s) => (
              <div key={String(s.sectionId)} style={{ display: "flex", gap: 10, padding: "7px 2px", borderTop: `1px solid ${T.line}`, fontSize: 13.5 }}>
                <div style={{ flex: 1, fontWeight: 600, color: T.ink }}>{s.label || "(section removed)"}</div>
                {s.visits > 1 && <span style={{ color: T.mute, fontSize: 12 }}>{s.visits} passes</span>}
                <div style={{ fontWeight: 700 }}>{secs(s.seconds)}</div>
              </div>
            ))}
          </Card>}

          <Card>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
              <H2 ui={ui}>What was marked</H2>
              <span style={{ fontSize: 12, color: T.mute }}>{d.items.length} item{d.items.length === 1 ? "" : "s"}</span>
            </div>
            {!d.items.length && <div style={{ fontSize: 13, color: T.mute }}>Nothing was marked on this visit.</div>}
            {d.items.map((it) => (
              <div key={it.id} style={{ display: "grid", gridTemplateColumns: "1fr 120px 90px 70px", gap: 10, alignItems: "center", padding: "8px 2px", borderTop: `1px solid ${T.line}`, fontSize: 13 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: T.ink }}>{it.product}{it.itemNo ? <span style={{ color: T.mute, fontWeight: 500 }}> #{it.itemNo}</span> : null}</div>
                  <div style={{ fontSize: 11.5, color: T.sub }}>{[it.section, it.where].filter(Boolean).join(" · ")}{it.note ? " · " + it.note : ""}</div>
                </div>
                <div style={{ color: T.sub, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.brand}</div>
                <Badge tone={STATUS_TONE[it.status] || "gray"}>{STATUS_LABEL[it.status] || it.status}</Badge>
                <div style={{ textAlign: "right", color: T.sub, fontSize: 12.5 }}>{secs(it.estSeconds)}</div>
              </div>
            ))}
            {d.items.length > 0 && <div style={{ fontSize: 11.5, color: T.mute, marginTop: 8, lineHeight: 1.5 }}>
              The time column is the gap since the previous action — an <b>estimate</b>, not a stopwatch. The first item includes walking to the shelf, and a photo lands inside the gap. Useful as a median across many visits, not row by row.
            </div>}
          </Card>

          {byBrand.length > 0 && <Card>
            <H2 ui={ui} style={{ marginBottom: 8 }}>Estimated time by brand</H2>
            {byBrand.map((b) => (
              <div key={b.brand} style={{ display: "flex", gap: 10, padding: "6px 2px", borderTop: `1px solid ${T.line}`, fontSize: 13.5 }}>
                <div style={{ flex: 1, fontWeight: 600, color: T.ink }}>{b.brand}</div>
                <div style={{ color: T.sub, fontSize: 12.5 }}>{b.items} item{b.items === 1 ? "" : "s"}</div>
                <div style={{ fontWeight: 700, width: 70, textAlign: "right" }}>{secs(b.seconds)}</div>
              </div>
            ))}
          </Card>}
        </>}
      </div>
    </div>
    {zoom && <div onClick={(e) => { e.stopPropagation(); setZoom(null); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 70, display: "grid", placeItems: "center", cursor: "zoom-out" }}>
      <img src={"/api/photos/" + zoom.id} alt="" style={{ maxWidth: "94vw", maxHeight: "94vh", objectFit: "contain" }} />
    </div>}
  </div>;
}

/* ---- Live ---- */
function LivePanel({ ui }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [live, setLive] = useState(null);
  const [openVisit, setOpenVisit] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => jget(ui, "/api/admin/live?date=" + date).then((r) => { if (alive) setLive(r); });
    load(); const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [date]);
  const visits = (live && live.visits) || [];
  const inProg = visits.filter((v) => v.inProgress).length;
  return <div>
    <PanelHead ui={ui} title="Live" body="Every visit started on a day, as it happens. Refreshes on its own every 30 seconds." right={<input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={Object.assign({}, inputStyle, { width: 170, padding: "8px 10px" })} />} />
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 180px)", gap: 12, marginBottom: 16 }}>
      {[[visits.length, "visits started"], [inProg, "in progress", T.amber], [visits.filter((v) => v.endedAt && v.closeReason === "manual").length, "finished", T.green]].map(([v, l, c]) => <Card key={l} pad={14} style={{ marginBottom: 0 }}><div style={{ fontFamily: ui.HEAD, fontWeight: 800, fontSize: 26, color: c || T.ink }}>{v}</div><div style={{ fontSize: 12.5, color: T.sub }}>{l}</div></Card>)}
    </div>
    <Card>
      {!live && <div style={{ color: T.mute }}>Loading…</div>}
      {live && !visits.length && <Empty ui={ui} icon="Clock" title="No visits yet" body="They'll appear here as merchandisers press Start Visit." />}
      {visits.map((v) => <div key={v.id} onClick={() => setOpenVisit(v.id)} title="Open this visit"
        style={{ display: "grid", gridTemplateColumns: "14px 1fr 1fr 180px 120px 16px", gap: 12, alignItems: "center", padding: "10px 4px", borderTop: `1px solid ${T.line}`, fontSize: 13.5, cursor: "pointer" }}>
        <span style={{ width: 10, height: 10, borderRadius: 999, background: v.inProgress ? T.amber : v.closeReason === "manual" ? T.green : T.mute }} />
        <div style={{ fontWeight: 700, color: T.ink }}>{v.merchName}</div>
        <div style={{ color: T.ink }}>{v.storeName || v.storeId}</div>
        <div style={{ color: T.sub, fontSize: 12.5 }}>{fmtTime(v.startedAt)}{v.endedAt ? ` – ${fmtTime(v.endedAt)}` : ""}</div>
        <div style={{ display: "flex", gap: 6 }}>
          {v.inProgress ? <Badge tone="amber">In progress</Badge> : v.closeReason === "manual" ? <Badge tone="green">Finished</Badge> : <Badge>Auto-closed</Badge>}
          {v.geoFlag && <span title="Location didn't match the store"><Icon ui={ui} name="AlertTriangle" size={14} color={T.red} /></span>}
        </div>
        <Icon ui={ui} name="ChevronRight" size={15} color={T.mute} />
      </div>)}
    </Card>
    {openVisit && <VisitDetail ui={ui} visitId={openVisit} onClose={() => setOpenVisit(null)} />}
  </div>;
}

/* ---- Reporting ---- */
function ReportingPanel({ ui }) {
  const today = new Date();
  const [from, setFrom] = useState(new Date(today.getTime() - 29 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today.toISOString().slice(0, 10));
  const [includeAuto, setIncludeAuto] = useState(false);
  const [tab, setTab] = useState("stores");
  const [rows, setRows] = useState(null);
  const [cats, setCats] = useState(null);
  const [brands, setBrands] = useState(null);
  const qs = "?from=" + from + "&to=" + to + "T23:59:59" + (includeAuto ? "&includeAutoClosed=1" : "");
  useEffect(() => { jget(ui, "/api/admin/reporting" + qs).then((r) => setRows((r && r.rows) || [])); }, [from, to, includeAuto]);
  useEffect(() => { if (tab === "categories") jget(ui, "/api/admin/reporting/categories" + qs).then(setCats); }, [tab, from, to, includeAuto]);
  useEffect(() => { if (tab === "brands") jget(ui, "/api/admin/reporting/brands" + qs).then(setBrands); }, [tab, from, to, includeAuto]);
  const totalVisits = (rows || []).reduce((n, r) => n + r.visits, 0);
  return <div>
    <PanelHead ui={ui} title="Reporting" body="Where the time goes. Only visits ended by pressing End Visit count by default — a visit closed by the nightly sweep or from the next store's parking lot is a known unknown, not a measurement." />
    <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
      {[["stores", "By store"], ["categories", "Beer vs Non-alc"], ["brands", "Effort by brand"]].map(([id, label]) => (
        <button key={id} onClick={() => setTab(id)} style={{ padding: "7px 14px", borderRadius: 9, border: `1px solid ${tab === id ? T.navy : T.line}`, background: tab === id ? T.navy : "#fff", color: tab === id ? "#fff" : T.sub, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>{label}</button>
      ))}
    </div>
    <Card pad={14} style={{ display: "flex", gap: 14, alignItems: "end", flexWrap: "wrap" }}>
      <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={Object.assign({}, inputStyle, { width: 160 })} /></Field>
      <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={Object.assign({}, inputStyle, { width: 160 })} /></Field>
      <label style={{ fontSize: 13, color: T.sub, display: "flex", alignItems: "center", gap: 6, paddingBottom: 10 }}><input type="checkbox" checked={includeAuto} onChange={(e) => setIncludeAuto(e.target.checked)} /> include auto-closed visits</label>
      <div style={{ flex: 1 }} />
      <div style={{ fontSize: 13, color: T.sub, paddingBottom: 10 }}><b style={{ color: T.ink }}>{totalVisits}</b> visits across <b style={{ color: T.ink }}>{(rows || []).length}</b> stores</div>
    </Card>
    {tab === "stores" && <Card>
      {rows && !rows.length && <Empty ui={ui} icon="Search" title="No finished visits in this range" body="Widen the dates, or include auto-closed visits." />}
      {rows && rows.length > 0 && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 100px 130px", gap: 12, padding: "4px 4px 8px", fontSize: 11.5, fontWeight: 700, color: T.mute, textTransform: "uppercase", letterSpacing: 0.5 }}><div>Store</div><div>Chain</div><div style={{ textAlign: "right" }}>Visits</div><div style={{ textAlign: "right" }}>Avg time</div></div>}
      {(rows || []).map((r) => <div key={r.storeId} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 100px 130px", gap: 12, padding: "9px 4px", borderTop: `1px solid ${T.line}`, fontSize: 13.5 }}>
        <div style={{ fontWeight: 600, color: T.ink }}>{r.storeName || r.storeId}</div>
        <div style={{ color: T.sub }}>{r.chain || ""}</div>
        <div style={{ textAlign: "right", color: T.ink }}>{r.visits}</div>
        <div style={{ textAlign: "right", fontWeight: 700, color: T.ink }}>{r.avgMinutes != null ? `${r.avgMinutes} min` : "—"}</div>
      </div>)}
    </Card>}

    {tab === "categories" && <Card>
      {!cats && <div style={{ color: T.mute }}>Loading…</div>}
      {cats && !cats.rows.length && <Empty ui={ui} icon="Clock" title="No finished visits in this range" body="Once merchandisers pick Beer or Non-alc at Start Visit, the split lands here." />}
      {cats && cats.rows.length > 0 && <>
        <div style={{ display: "flex", height: 26, borderRadius: 7, overflow: "hidden", marginBottom: 14, border: `1px solid ${T.line}` }}>
          {cats.rows.map((r) => <div key={r.category || "unset"} title={`${r.label}: ${r.minutes} min`} style={{ width: (r.sharePct || 0) + "%", background: r.category === "beer" ? T.navy : r.category === "na" ? T.green : T.mute, color: "#fff", fontSize: 11, fontWeight: 700, display: "grid", placeItems: "center" }}>{(r.sharePct || 0) >= 8 ? r.sharePct + "%" : ""}</div>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 90px 90px 110px", gap: 12, padding: "4px 4px 8px", fontSize: 11.5, fontWeight: 700, color: T.mute, textTransform: "uppercase", letterSpacing: 0.5 }}>
          <div>Category</div><div style={{ textAlign: "right" }}>Visits</div><div style={{ textAlign: "right" }}>Items</div><div style={{ textAlign: "right" }}>Avg visit</div><div style={{ textAlign: "right" }}>Total time</div>
        </div>
        {cats.rows.map((r) => <div key={r.category || "unset"} style={{ display: "grid", gridTemplateColumns: "1fr 90px 90px 90px 110px", gap: 12, padding: "9px 4px", borderTop: `1px solid ${T.line}`, fontSize: 13.5 }}>
          <div style={{ fontWeight: 600, color: T.ink }}>{r.category ? r.label : <span style={{ color: T.sub }}>Not specified</span>}</div>
          <div style={{ textAlign: "right" }}>{r.visits}</div>
          <div style={{ textAlign: "right" }}>{r.items}</div>
          <div style={{ textAlign: "right" }}>{r.avgMinutes == null ? "—" : r.avgMinutes + " min"}</div>
          <div style={{ textAlign: "right", fontWeight: 700 }}>{r.minutes == null ? "—" : r.minutes + " min"}</div>
        </div>)}
        <div style={{ fontSize: 11.5, color: T.mute, marginTop: 10, lineHeight: 1.5 }}>
          This is <b>measured</b>, not apportioned: a visit carries the category the merchandiser picked, so its whole length belongs to that category. Visits started before categories existed, or where they chose "both", show as <i>Not specified</i>.
        </div>
      </>}
    </Card>}

    {tab === "brands" && <Card>
      {!brands && <div style={{ color: T.mute }}>Loading…</div>}
      {brands && !brands.rows.length && <Empty ui={ui} icon="Search" title="Nothing marked in this range" body="This builds from items merchandisers tick off during a visit." />}
      {brands && brands.rows.length > 0 && <>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 90px 110px 110px", gap: 12, padding: "4px 4px 8px", fontSize: 11.5, fontWeight: 700, color: T.mute, textTransform: "uppercase", letterSpacing: 0.5 }}>
          <div>Brand</div><div>Category</div><div style={{ textAlign: "right" }}>Items</div><div style={{ textAlign: "right" }}>Median / item</div><div style={{ textAlign: "right" }}>Total est.</div>
        </div>
        {brands.rows.map((r) => <div key={r.brand + (r.category || "")} style={{ display: "grid", gridTemplateColumns: "1fr 110px 90px 110px 110px", gap: 12, padding: "9px 4px", borderTop: `1px solid ${T.line}`, fontSize: 13.5 }}>
          <div style={{ fontWeight: 600, color: T.ink }}>{r.brand}</div>
          <div>{r.category ? <Badge tone={r.category === "beer" ? "navy" : "green"}>{r.categoryLabel}</Badge> : <span style={{ color: T.mute, fontSize: 12 }}>—</span>}</div>
          <div style={{ textAlign: "right" }}>{r.items}</div>
          <div style={{ textAlign: "right" }}>{secs(r.medianSeconds)}</div>
          <div style={{ textAlign: "right", fontWeight: 700 }}>{r.minutes} min</div>
        </div>)}
        <div style={{ fontSize: 11.5, color: T.mute, marginTop: 10, lineHeight: 1.5 }}>
          <b>Estimated.</b> Time per item is the gap between consecutive marks during a visit, so the first item of a section includes walking to it and a photo lands inside the gap. Each gap is capped at {Math.round(brands.capSeconds / 60)} minutes before it counts, so one long pause can't land on whatever brand came next{brands.cappedTotal ? ` (${brands.cappedTotal} gap${brands.cappedTotal === 1 ? " was" : "s were"} capped in this range)` : ""}. Read the median across many visits, not a single row.
        </div>
      </>}
    </Card>}
  </div>;
}

function App({ ui, boot, role, onLogout, onRefresh }) {
  return role === "proofadmin" ? <AdminApp ui={ui} boot={boot} onLogout={onLogout} /> : <MerchApp ui={ui} boot={boot} onLogout={onLogout} onRefresh={onRefresh} />;
}

export { App, MerchApp, TodayList, LeaderboardScreen, StoreFlow, DoneScreen, AdminApp, ScheduleBoard, BlockStores, StoresPanel, CatalogPanel, TeamPanel, DevicesPanel, LivePanel, ReportingPanel, VisitDetail, FileDrop, Sheet, Chip };
