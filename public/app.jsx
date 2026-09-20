/* public/app.jsx -- Proof's client shell: sign-in, session, the error
   boundary, and the mount for the screens in proof-ui.jsx. One bundle. */
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ClipboardList, ShieldCheck, Check, X, ChevronRight, ChevronLeft, MapPin, Clock, Camera, AlertTriangle, Search, Users, Plus, Trash2, CalendarDays, Upload } from "lucide-react";
import { App as ProofScreens } from "./proof-ui.jsx";

const HEAD = "'Archivo', Inter, system-ui, sans-serif";
const BODY = "'Inter', system-ui, sans-serif";
const BRAND = { navy: "#0E1F3C", white: "#FFFFFF", green: "#1E9E5A", line: "#E4E7EC", ink: "#16243B", sub: "#5C6A80", mute: "#98A2B3", red: "#C62828" };

const TOK_KEY = "proof_auth";
let AUTH = ""; try { AUTH = localStorage.getItem(TOK_KEY) || ""; } catch (e) {}
function setAuth(t) { AUTH = t || ""; try { if (t) localStorage.setItem(TOK_KEY, t); else localStorage.removeItem(TOK_KEY); } catch (e) {} }
const H = () => ({ "Content-Type": "application/json", ...(AUTH ? { "x-auth-token": AUTH } : {}) });
const j = (r) => r.json();
const API = {
  loginOptions: () => fetch("/api/login-options").then(j),
  login: (id, pin, deviceId) => fetch("/api/login", { method: "POST", headers: H(), body: JSON.stringify({ id, pin, deviceId }) }).then(j),
  logout: () => fetch("/api/logout", { method: "POST", headers: H() }).then(j).catch(() => ({})),
  bootstrap: () => fetch("/api/bootstrap", { headers: H() }).then((r) => r.status === 401 || r.status === 403 ? { _unauth: true } : r.json()),
};
// An identifier, not a secret: the device-binding key (lib docs, S1.4).
function deviceId() {
  let id = null;
  try {
    id = localStorage.getItem("proof_device");
    if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now()); localStorage.setItem("proof_device", id); }
  } catch (e) {}
  return id;
}

const UI = { HEAD, BODY, H, brand: BRAND, C: { line: BRAND.line, ink: BRAND.ink, sub: BRAND.sub, mute: BRAND.mute, redDeep: BRAND.red },
  icons: { ClipboardList, ShieldCheck, Check, X, ChevronRight, ChevronLeft, MapPin, Clock, Camera, AlertTriangle, Search, Users, Plus, Trash2, CalendarDays, Upload } };

function Mark({ size }) {
  const s = size || 40;
  return <span style={{ display: "inline-flex", width: s, height: s, borderRadius: s * 0.26, background: BRAND.white, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
    <svg width={s * 0.62} height={s * 0.62} viewBox="0 0 24 24" fill="none" stroke={BRAND.green} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
  </span>;
}

function Login({ onAuthed }) {
  const [people, setPeople] = useState(null);
  const [pending, setPending] = useState(false);
  const [sel, setSel] = useState(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { (async () => {
    try { const r = await API.loginOptions(); setPeople(r.people || []); setPending(!!r.pending); }
    catch (e) { setPeople([]); setErr("Couldn't reach the server."); }
  })(); }, []);
  const selObj = (people || []).find((p) => p.id === sel);
  async function submit() {
    if (!sel || !pin) { setErr("Enter your PIN."); return; }
    setBusy(true); setErr("");
    try {
      const r = await API.login(sel, pin, deviceId());
      if (r && r.token) { setAuth(r.token); onAuthed(); return; }
      setErr(r && r.error === "device_pending" ? "New phone — ask your admin to approve it, then try again."
        : r && r.error === "device_revoked" ? "This phone was blocked. See your admin."
        : "That PIN didn't match.");
      setPin("");
    } catch (e) { setErr("Couldn't reach the server."); }
    setBusy(false);
  }
  return <div style={{ height: "100%", display: "flex", flexDirection: "column", background: BRAND.white }}>
    <div style={{ background: BRAND.navy, padding: "calc(28px + env(safe-area-inset-top)) 20px 24px", textAlign: "center" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
        <Mark size={38} />
        <span style={{ fontFamily: HEAD, fontWeight: 800, fontSize: 34, letterSpacing: 1.5, color: "#fff" }}>PROOF</span>
      </div>
      <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, marginTop: 8 }}>Visit it. Photo it. Prove it.</div>
    </div>
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px 28px" }}>
      {people === null && !err && <div style={{ color: BRAND.mute, textAlign: "center", marginTop: 24 }}>Loading…</div>}
      {people !== null && people.length === 0 && <div style={{ textAlign: "center", color: BRAND.sub, marginTop: 24, fontSize: 14, lineHeight: 1.55 }}>
        {pending ? "Proof is still setting up its database. Give it a moment and refresh." : "No one can sign in yet — the admin account is created on first start. Refresh in a moment."}
      </div>}
      {people !== null && people.length > 0 && <>
        <div style={{ color: BRAND.sub, fontSize: 13.5, marginBottom: 12 }}>Who are you?</div>
        <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
          {people.map((p) => <button key={p.id} onClick={() => { setSel(p.id); setPin(""); setErr(""); }}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 14px", borderRadius: 13, border: `1.5px solid ${sel === p.id ? BRAND.navy : BRAND.line}`, background: sel === p.id ? "#EEF1F6" : "#fff", cursor: "pointer", textAlign: "left" }}>
            {p.role === "admin" ? <ShieldCheck size={20} color={BRAND.navy} /> : <ClipboardList size={20} color={BRAND.navy} />}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, color: BRAND.ink, fontSize: 15.5 }}>{p.name}</div>
              <div style={{ color: BRAND.mute, fontSize: 12 }}>{p.role === "admin" ? "Admin" : "Merchandiser"}</div>
            </div>
            {sel === p.id && <Check size={18} color={BRAND.green} />}
          </button>)}
        </div>
        {selObj && <>
          <div style={{ fontFamily: HEAD, fontSize: 11.5, letterSpacing: 1, color: BRAND.sub, textTransform: "uppercase", marginBottom: 6 }}>Your PIN</div>
          <input className="pin-input" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} inputMode="numeric" type="password" autoComplete="off" placeholder="••••" autoFocus />
          {err && <div style={{ color: BRAND.red, fontSize: 13.5, fontWeight: 600, marginTop: 10 }}>{err}</div>}
          <button disabled={busy} onClick={submit} style={{ width: "100%", marginTop: 16, padding: "15px 20px", fontSize: 17, fontFamily: HEAD, fontWeight: 700, background: BRAND.navy, color: "#fff", border: "none", borderRadius: 12, cursor: "pointer", opacity: busy ? 0.7 : 1 }}>{busy ? "Signing in…" : "Sign in"}</button>
        </>}
      </>}
      {err && people !== null && people.length === 0 && <div style={{ color: BRAND.red, fontSize: 13.5, textAlign: "center", marginTop: 12 }}>{err}</div>}
    </div>
  </div>;
}

// A field app must never blank-screen. A thrown render gets a message and a retry.
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err) { try { console.error("[proof] render failed:", err); } catch (e) {} }
  render() {
    if (!this.state.err) return this.props.children;
    return <div style={{ padding: 22, minHeight: "100%", background: BRAND.white }}>
      <div style={{ background: "#fff", border: `1.5px solid ${BRAND.red}`, borderRadius: 14, padding: 18, maxWidth: 520 }}>
        <div style={{ fontFamily: HEAD, fontWeight: 700, fontSize: 17, color: BRAND.ink, marginBottom: 6 }}>Something went wrong on this screen</div>
        <div style={{ color: BRAND.sub, fontSize: 13.5, lineHeight: 1.5 }}>Your work is safe. Try again, and if it keeps happening, tell your admin what you were doing.</div>
        <div style={{ color: BRAND.mute, fontSize: 11.5, marginTop: 8, fontFamily: "ui-monospace, Menlo, monospace" }}>{String((this.state.err && this.state.err.message) || this.state.err).slice(0, 160)}</div>
        <button style={{ marginTop: 14, padding: "12px 18px", fontFamily: HEAD, fontWeight: 700, background: BRAND.navy, color: "#fff", border: "none", borderRadius: 11, cursor: "pointer" }}
          onClick={() => { this.setState({ err: null }); if (this.props.onReset) this.props.onReset(); }}>Try again</button>
      </div>
    </div>;
  }
}

// One tree across every width: only maxWidth changes (an iPad crosses the
// desktop line on every rotate, and a remount would drop a visit's state).
function useIsDesktop() {
  const [d, setD] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => { const m = window.matchMedia("(min-width: 1024px)"); const f = () => setD(m.matches); m.addEventListener ? m.addEventListener("change", f) : m.addListener(f); return () => { m.removeEventListener ? m.removeEventListener("change", f) : m.removeListener(f); }; }, []);
  return d;
}
function Shell({ full, children }) {
  const desktop = useIsDesktop();
  return <div style={{ maxWidth: full && desktop ? "none" : 460, margin: "0 auto", height: "100dvh", background: BRAND.white, color: BRAND.ink, fontFamily: BODY, position: "relative", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: !full && desktop ? "0 0 0 1px " + BRAND.line : "none" }}>{children}</div>;
}

function Root() {
  const [loading, setLoading] = useState(true);
  const [needAuth, setNeedAuth] = useState(!AUTH);
  const [boot, setBoot] = useState(null);
  const [role, setRole] = useState(null);
  async function load() {
    if (!AUTH) { setNeedAuth(true); setLoading(false); return null; }
    try {
      const b = await API.bootstrap();
      if (!b || b._unauth) { setAuth(""); setNeedAuth(true); setBoot(null); setRole(null); }
      else if (b.error && b.pending) { setTimeout(load, 1500); return b; }
      else { setBoot(b); setRole(b.me && b.me.role === "admin" ? "proofadmin" : "proof"); setNeedAuth(false); }
      return b;
    } catch (e) { setNeedAuth(true); return null; }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  async function logout() { try { await API.logout(); } catch (e) {} setAuth(""); setBoot(null); setRole(null); setNeedAuth(true); }
  if (loading) return <Shell><div className="pulse" style={{ flex: 1, display: "grid", placeItems: "center" }}><span style={{ display: "inline-flex", width: 64, height: 64, borderRadius: 16, background: BRAND.navy, alignItems: "center", justifyContent: "center" }}><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span></div></Shell>;
  if (needAuth || !boot) return <Shell><Login onAuthed={() => { setLoading(true); load(); }} /></Shell>;
  return <Shell full={role === "proofadmin"}><Boundary onReset={load}><ProofScreens ui={UI} boot={boot} role={role} onLogout={logout} onRefresh={load} /></Boundary></Shell>;
}

createRoot(document.getElementById("root")).render(<Root />);
