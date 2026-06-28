import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  addSessionScreenshot, saveScreenshot,
  getSessionScreenshots, pasteSelectedToApp, pasteToApp, removeSessionScreenshot,
  hidePanel, getLastActiveApp, resizePanel, showGallery,
} from "../lib/tauri";
import type { ActiveApp, ClipboardImageEvent } from "../lib/tauri";

function Ri({ icon, gradient, size = 16 }: { icon: string; gradient: string; size?: number }) {
  return (
    <i className={icon} style={{
      fontSize: size, lineHeight: 1, display: "inline-block",
      background: gradient,
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
      backgroundClip: "text",
    }} />
  );
}

// ── AI destination config ────────────────────────────────────────────────────
const DESTINATIONS = [
  { id: "claude",  bundleId: "com.anthropic.claudefordesktop", name: "Claude",  logo: <ClaudeLogo /> },
  { id: "chatgpt", bundleId: "com.openai.chat",                name: "ChatGPT", logo: <ChatGPTLogo /> },
  { id: "figma",   bundleId: "com.figma.Desktop",              name: "Figma",   logo: <FigmaLogo /> },
];

const PANEL_WIDTH = 320;
const PANEL_BASE_HEIGHT = 400;
const THUMBNAIL_ROW_HEIGHT = 92;

function panelHeightForCaptureCount(count: number) {
  const rows = Math.max(1, Math.ceil(count / 2));
  const rawHeight = PANEL_BASE_HEIGHT + Math.max(0, rows - 1) * THUMBNAIL_ROW_HEIGHT;
  const screenCap = typeof window === "undefined"
    ? rawHeight
    : Math.max(PANEL_BASE_HEIGHT, window.screen.availHeight - 40);

  return Math.min(rawHeight, screenCap);
}

interface Props { event: ClipboardImageEvent | null; }

export default function FloatingPanel({ event }: Props) {
  const [shots, setShots]       = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busyDest, setBusyDest] = useState<string | null>(null);
  const [status, setStatus]     = useState<{ msg: string; ok: boolean } | null>(null);
  const [activeApp, setActiveApp] = useState<ActiveApp>({ bundle_id: "", name: "" });
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  function resetDismissTimer() {
    const autoDismiss = localStorage.getItem("te_autoDismiss") !== "0";
    if (!autoDismiss) return;
    const secs = Number(localStorage.getItem("te_dismissTimer") ?? 30);
    if (dismissRef.current) clearTimeout(dismissRef.current);
    dismissRef.current = setTimeout(() => { hidePanel().catch(() => {}); }, secs * 1000);
  }

  useEffect(() => {
    getSessionScreenshots().then(s => {
      setShots(s); setSelected(new Set(s.map((_,i) => i)));
    });
    getLastActiveApp().then(setActiveApp).catch(() => {});
    const appTimer = setInterval(() => {
      getLastActiveApp().then(setActiveApp).catch(() => {});
    }, 250);
    resetDismissTimer();
    return () => {
      clearInterval(appTimer);
      if (dismissRef.current) clearTimeout(dismissRef.current);
    };
  }, []);

  useEffect(() => {
    if (!event) return;
    addSessionScreenshot(event.data_url)
      .then(() => getSessionScreenshots())
      .then(s => { setShots(s); setSelected(new Set(s.map((_,i) => i))); });
    getLastActiveApp().then(setActiveApp).catch(() => {});
    resetDismissTimer();
  }, [event]);

  function toggleSelect(i: number) {
    setSelected(p => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });
  }

  async function handleRemove(i: number) {
    await removeSessionScreenshot(i);
    const s = await getSessionScreenshots();
    setShots(s);
    setSelected(p => {
      const n = new Set<number>();
      p.forEach(x => { if (x !== i) n.add(x > i ? x - 1 : x); });
      return n;
    });
  }

  const selUrls  = [...selected].sort().map(i => shots[i]).filter(Boolean);
  const selCount = selected.size;
  const isBusy   = busyDest !== null;
  const activeToolName = activeApp.name || "Tool";
  const panelHeight = panelHeightForCaptureCount(shots.length);

  useEffect(() => {
    resizePanel(panelHeight).catch(() => {});
  }, [panelHeight]);

  function showStatus(msg: string, ok: boolean) {
    setStatus({ msg, ok });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setStatus(null), 2500);
  }

  async function pasteTo(dest: typeof DESTINATIONS[0]) {
    if (!selCount) return;
    setBusyDest(dest.id);
    try {
      selUrls.length === 1
        ? await pasteToApp(selUrls[0], dest.bundleId)
        : await pasteSelectedToApp(selUrls, dest.bundleId);
    } catch {
      showStatus("Allow Accessibility in System Settings.", false);
    } finally { setBusyDest(null); }
  }

  async function handlePasteOnTool() {
    if (!selCount) return;
    setBusyDest("active-tool");
    try {
      if (selUrls.length === 1) {
        await pasteToApp(selUrls[0], activeApp.bundle_id);
      } else {
        await pasteSelectedToApp(selUrls, activeApp.bundle_id);
      }
    } catch { showStatus("Allow Accessibility in System Settings.", false); }
    finally { setBusyDest(null); }
  }

  function startPanelDrag(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    void getCurrentWindow().startDragging().catch(() => {});
  }

  async function handleSave() {
    if (!selCount) return;
    setBusyDest("save");
    let saved = 0;
    try {
      for (const url of selUrls) {
        await saveScreenshot(url, "TooEasy");
        saved++;
      }
      showStatus(`${saved} image${saved > 1 ? "s" : ""} saved to library`, true);
    } catch { showStatus("Save failed.", false); }
    finally { setBusyDest(null); }
  }

  return (
    <>
      <div className="liquid-panel-material" style={{
        width: PANEL_WIDTH,
        height: panelHeight,
        maxHeight: panelHeight,
        background: "transparent",
        border: "none",
        borderRadius: 30,
        boxShadow: "none",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
        fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
        color: "rgba(20,24,33,0.86)",
      }}>
        <div className="liquid-panel-content">

        {/* Header */}
        <div
          data-tauri-drag-region
          onMouseDown={startPanelDrag}
          style={{
            display:"flex", alignItems:"center", padding:"14px 16px 10px", gap:10,
            cursor:"grab", userSelect:"none",
          }}
        >
          <div style={{
            width:31, height:31, borderRadius:11, flexShrink:0,
            background:"rgba(255,255,255,0.32)",
            border:"1px solid rgba(255,255,255,0.46)",
            display:"flex", alignItems:"center", justifyContent:"center",
            boxShadow:"inset 0 1px 0 rgba(255,255,255,0.62)",
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"
                stroke="rgba(31,41,55,0.64)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="12" cy="13" r="4" stroke="rgba(31,41,55,0.64)" strokeWidth="2"/>
            </svg>
          </div>
          <span className="glass-text" style={{ fontSize:15, fontWeight:600, letterSpacing:"0", flex:1 }}>
            TooEasy
          </span>
          {/* Close button */}
          <button
            onClick={() => hidePanel().catch(() => {})}
            title="Close"
            style={{
              width:28, height:28, borderRadius:"50%", flexShrink:0,
              background:"rgba(255,255,255,0.22)", border:"1px solid rgba(255,255,255,0.36)",
              display:"flex", alignItems:"center", justifyContent:"center",
              cursor:"pointer", padding:0,
              boxShadow:"inset 0 1px 0 rgba(255,255,255,0.52)",
            }}
          >
            <Ri icon="ri-close-fill" gradient="linear-gradient(135deg,#9ca3af,#6b7280)" size={13} />
          </button>
        </div>

        {/* Screenshot tray */}
        <div style={{ padding:"8px 16px 10px" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
            <span className="glass-text" style={{ fontSize:10.5, fontWeight:600, letterSpacing:"0.06em", textTransform:"uppercase", opacity:0.72 }}>
              {shots.length === 0 ? "No captures" : `${shots.length} screenshot${shots.length>1?"s":""} · ${selCount} selected`}
            </span>
            {shots.length > 1 && (
              <div style={{ display:"flex", gap:4 }}>
                <button onClick={() => setSelected(new Set(shots.map((_,i)=>i)))} style={chipSt}>All</button>
                <button onClick={() => setSelected(new Set())} style={chipSt}>None</button>
              </div>
            )}
          </div>

          <div style={{
            minHeight:104, overflow:"visible",
            background:"transparent", borderRadius:14, padding:"3px 2px",
            border:"none",
            boxShadow:"none",
            display: shots.length === 0 ? "flex" : "grid",
            gridTemplateColumns: shots.length === 0 ? undefined : "repeat(2, minmax(0, 1fr))",
            gap:10,
            alignItems: shots.length === 0 ? "center" : "flex-start",
            justifyContent: shots.length === 0 ? "center" : "flex-start",
          }}>
            {shots.length === 0 ? (
              <span className="glass-text" style={{ fontSize:13, fontWeight:560, opacity:0.72 }}>Take a screenshot to begin</span>
            ) : shots.map((url, i) => {
              const isSel = selected.has(i);
              return (
                <div
                  key={i}
                  className="shot-tile"
                  data-selected={isSel}
                  onClick={() => toggleSelect(i)}
                  style={{
                    position:"relative", minWidth:0, cursor:"pointer",
                    padding:4, borderRadius:15,
                    background: isSel ? "rgba(126,87,255,0.06)" : "rgba(255,255,255,0.08)",
                    border: isSel ? "2px solid rgba(126,87,255,0.95)" : "1px solid rgba(255,255,255,0.20)",
                    boxShadow: isSel
                      ? "0 7px 18px rgba(126,87,255,0.16), inset 0 1px 0 rgba(255,255,255,0.30)"
                      : "inset 0 1px 0 rgba(255,255,255,0.18)",
                  }}
                >
                  <img src={url} style={{
                    width:"100%", height:72, objectFit:"cover", borderRadius:11, display:"block",
                    boxShadow:"0 6px 14px rgba(31,38,62,0.13)",
                    transition:"filter 120ms",
                  }}/>
                  <button className="shot-action" onClick={e => { e.stopPropagation(); handleRemove(i); }} style={{
                    position:"absolute", top:7, right:7, width:20, height:20,
                    borderRadius:7, background:"rgba(239,68,68,0.92)",
                    border:"1px solid rgba(255,255,255,0.72)", color:"white",
                    cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
                    padding:0,
                    boxShadow:"0 4px 12px rgba(0,0,0,0.18)",
                  }}>
                    <i className="ri-close-fill" style={{ fontSize:11, color:"white", WebkitTextFillColor:"white", lineHeight:1 }} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Primary paste */}
        <div style={{ padding:"4px 16px 0" }}>
          <button onClick={handlePasteOnTool} disabled={!selCount || isBusy || !activeApp.bundle_id} style={{
            width:"100%", height:42,
            background: !selCount || isBusy ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.34)",
            border:"1px solid rgba(255,255,255,0.46)", borderRadius:999,
            color:"rgba(20,24,33,0.86)",
            fontSize:13.5, fontWeight:600, cursor: selCount && !isBusy && activeApp.bundle_id ? "pointer" : "default",
            display:"flex", alignItems:"center", justifyContent:"center", gap:6,
            fontFamily:"inherit",
            boxShadow:"0 10px 24px rgba(17,24,39,0.08), inset 0 1px 0 rgba(255,255,255,0.52)",
            minWidth:0, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
          }}>
            <span className="glass-text" style={{ overflow:"hidden", textOverflow:"ellipsis", opacity: !selCount || isBusy ? 0.48 : 1 }}>
              {busyDest==="active-tool" ? "Pasting…" : `Paste on ${activeToolName}`}
            </span>
          </button>
        </div>

        {/* AI shortcuts */}
        <div style={{ padding:"14px 16px 0" }}>
          <span className="glass-text" style={{ fontSize:10, fontWeight:600, letterSpacing:"0.07em", textTransform:"uppercase", opacity:0.5 }}>
            Send to App
          </span>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4, minmax(0, 1fr))", gap:8, marginTop:8 }}>
            {DESTINATIONS.map(dest => {
              const isThis = busyDest === dest.id;
              return (
                <button key={dest.id}
                  onClick={() => pasteTo(dest)}
                  disabled={!selCount || isBusy}
                  title={`Paste into ${dest.name}`}
                  style={{
                    display:"flex", flexDirection:"column", alignItems:"center", gap:5,
                    padding:"8px 5px", borderRadius:16,
                    background: isThis ? "rgba(255,255,255,0.34)" : "rgba(255,255,255,0.20)",
                    border:"1px solid rgba(255,255,255,0.36)",
                    cursor: selCount && !isBusy ? "pointer" : "default",
                    opacity: isBusy && !isThis ? 0.35 : 1,
                    minWidth: 0,
                    boxShadow:"inset 0 1px 0 rgba(255,255,255,0.42)",
                  }}
                >
                  <div style={{ width:30, height:30, borderRadius:10, overflow:"hidden", display:"flex", alignItems:"center", justifyContent:"center" }}>
                    {dest.logo}
                  </div>
                  <span className="glass-text" style={{ fontSize:9.5, fontWeight:600, maxWidth:"100%", overflow:"hidden", textOverflow:"ellipsis" }}>
                    {isThis ? "…" : dest.name}
                  </span>
                </button>
              );
            })}
            <button onClick={handleSave} disabled={!selCount || isBusy} title="Save to gallery" style={{
              display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:5,
              padding:"8px 5px", borderRadius:16,
              background: busyDest === "save" ? "rgba(255,255,255,0.34)" : "rgba(255,255,255,0.20)",
              border:"1px solid rgba(255,255,255,0.36)",
              cursor: selCount && !isBusy ? "pointer" : "default",
              opacity: isBusy && busyDest !== "save" ? 0.35 : 1,
              minWidth:0,
              boxShadow:"inset 0 1px 0 rgba(255,255,255,0.42)",
            }}>
              {busyDest === "save"
                ? <Ri icon="ri-check-fill"    gradient="linear-gradient(135deg,#10b981,#34d399)" size={22} />
                : <Ri icon="ri-bookmark-fill" gradient="linear-gradient(135deg,#f59e0b,#f97316)" size={22} />
              }
              <span className="glass-text" style={{ fontSize:9.5, fontWeight:600 }}>Save</span>
            </button>
          </div>
        </div>

        {/* Open Gallery */}
        <div style={{ padding:"10px 16px 18px", display:"flex", justifyContent:"center" }}>
          <button onClick={() => { showGallery().catch(()=>{}); }} style={{
            background:"none", border:"none", cursor:"pointer", fontFamily:"inherit",
            display:"flex", alignItems:"center", gap:4, padding:"4px 8px",
          }}>
            <span className="glass-text" style={{ fontSize:12, fontWeight:500, opacity:0.55 }}>Open Gallery</span>
            <i className="ri-arrow-right-s-line" style={{ fontSize:14, color:"rgba(20,24,33,0.45)", WebkitTextFillColor:"rgba(20,24,33,0.45)", lineHeight:1 }} />
          </button>
        </div>

        {/* Status toast */}
        {status && (
          <div style={{
            margin:"0 13px 12px", padding:"8px 12px",
            background: status.ok ? "rgba(220,252,231,0.50)" : "rgba(254,226,226,0.52)",
            border:`1px solid ${status.ok ? "rgba(34,197,94,0.28)" : "rgba(239,68,68,0.28)"}`,
            borderRadius:13, fontSize:12,
            color: status.ok ? "#15803d" : "#dc2626",
            textAlign:"center",
            boxShadow:"inset 0 1px 0 rgba(255,255,255,0.38)",
          }}>{status.msg}</div>
        )}
        </div>
      </div>
    </>
  );
}

// ── AI Brand Logos (bundled local assets) ────────────────────────────────────
import claudeLogoUrl from "../assets/logos/claude.svg";
import chatgptLogoUrl from "../assets/logos/chatgpt.svg";
import figmaLogoUrl from "../assets/logos/figma.svg";

function ClaudeLogo()  { return <LogoImg src={claudeLogoUrl}  alt="Claude" />; }
function ChatGPTLogo() { return <LogoImg src={chatgptLogoUrl} alt="ChatGPT" />; }
function FigmaLogo() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300" width="20" height="30" style={{ display:"block" }}>
      <path fill="#0acf83" d="M50 300c27.6 0 50-22.4 50-50v-50H50c-27.6 0-50 22.4-50 50s22.4 50 50 50z"/>
      <path fill="#a259ff" d="M0 150c0-27.6 22.4-50 50-50h50v100H50c-27.6 0-50-22.4-50-50z"/>
      <path fill="#f24e1e" d="M0 50C0 22.4 22.4 0 50 0h50v100H50C22.4 100 0 77.6 0 50z"/>
      <path fill="#ff7262" d="M100 0h50c27.6 0 50 22.4 50 50s-22.4 50-50 50h-50V0z"/>
      <path fill="#1abcfe" d="M200 150c0 27.6-22.4 50-50 50s-50-22.4-50-50 22.4-50 50-50 50 22.4 50 50z"/>
    </svg>
  );
}

function LogoImg({ src, alt }: { src: string; alt: string }) {
  return <img src={src} alt={alt} width={30} height={30} draggable={false}
    style={{ display:"block", objectFit:"contain", userSelect:"none" }} />;
}


// ── Shared styles ─────────────────────────────────────────────────────────────
const chipSt: React.CSSProperties = {
  height:19, padding:"0 8px",
  background:"rgba(255,255,255,0.38)", border:"1px solid rgba(255,255,255,0.46)",
  borderRadius:999, color:"#6b7280",
  fontSize:10, fontWeight:500, cursor:"pointer",
  boxShadow:"inset 0 1px 0 rgba(255,255,255,0.46)",
};
