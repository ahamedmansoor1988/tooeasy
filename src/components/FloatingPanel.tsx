import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  addSessionScreenshot, saveScreenshot,
  getSessionScreenshots, pasteSelectedToApp, pasteToApp, removeSessionScreenshot,
  clearSessionScreenshots,
  hidePanel, getLastActiveApp, resizePanel, showGallery, getIsPro,
  activateLicense,
} from "../lib/tauri";
import type { ActiveApp, ClipboardImageEvent } from "../lib/tauri";

// Set to your Gumroad/LemonSqueezy purchase URL once you publish
const PURCHASE_URL = "https://tooeasy.gumroad.com/l/pro";

function Ri({ icon, gradient, size = 16 }: { icon: string; gradient: string; size?: number }) {
  void gradient;
  return (
    <i className={icon} style={{
      fontSize: size, lineHeight: 1, display: "inline-block",
      color: "var(--panel-icon)",
      WebkitTextFillColor: "var(--panel-icon)",
    }} />
  );
}

const PANEL_WIDTH = 320;
const PANEL_EMPTY_HEIGHT = 458;
const PANEL_BASE_HEIGHT = 476;
const PANEL_ROW_HEIGHT = 80;
const PANEL_STATUS_HEIGHT = 56;
const PANEL_TRANSITION_MS = 220;
const COLS = 3;
const FREE_LIMIT = 6;
const PRO_LIMIT = 20;


interface Props { event: ClipboardImageEvent | null; }

const SENSITIVE_PATTERNS: RegExp[] = [
  /(?:api[_\- ]?key|api[_\- ]?secret|password|passwd|pwd|secret|token|auth(?:key)?|credential|access[_\- ]?key|private[_\- ]?key|db[_\- ]?pass(?:word)?|database[_\- ]?(?:url|password))\s*[-:=\s]\s*(\S{4,})/gi,
  /\b(sk-[a-zA-Z0-9_-]{10,}|gsk_[a-zA-Z0-9_-]{10,}|sk-ant-[a-zA-Z0-9_-]{10,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{20,}|xox[bpa]-[a-zA-Z0-9-]{10,})/g,
  /[Bb]earer\s+([a-zA-Z0-9._~+/=-]{10,})/g,
  /\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g,
  /\b(\d{3}-\d{2}-\d{4})\b/g,
];

async function scanForSensitive(dataUrl: string): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    type OcrLine = { text: string; y: number; h: number };
    const lines: OcrLine[] = await invoke("ocr_data_url", { dataUrl });
    const fullText = lines.map(l => l.text).join("\n");
    for (const pat of SENSITIVE_PATTERNS) {
      pat.lastIndex = 0;
      if (pat.test(fullText)) return true;
    }
    return false;
  } catch { return false; }
}

export default function FloatingPanel({ event }: Props) {
  const [shots, setShots]       = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busyDest, setBusyDest] = useState<string | null>(null);
  const [status, setStatus]     = useState<{ msg: string; ok: boolean } | null>(null);
  const [activeApp, setActiveApp] = useState<ActiveApp>({ bundle_id: "", name: "" });
  const [isPro, setIsPro]       = useState(false);
  const [sensitiveShots, setSensitiveShots] = useState<Set<string>>(new Set());
  const isProRef      = useRef(false);
  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nativeHeightRef = useRef(PANEL_EMPTY_HEIGHT);
  const savingRef     = useRef(false);
  // Source app for each capture, keyed by data URL — recorded at capture time
  // so saving later still attributes the screenshot to the right app.
  const sourcesRef    = useRef(new Map<string, string>());

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
    getIsPro().then(v => { setIsPro(v); isProRef.current = v; }).catch(() => {});
    getLastActiveApp().then(setActiveApp).catch(() => {});
    const appTimer = setInterval(() => {
      getLastActiveApp().then(app => {
        setActiveApp(prev => prev.bundle_id === app.bundle_id ? prev : app);
      }).catch(() => {});
    }, 600);
    resetDismissTimer();

    let unlistenCap: (() => void) | null = null;
    listen("screenshot-cap-reached", () => {
      if (isProRef.current) {
        showStatus("Supports only 20 images for now", true);
      } else {
        showStatus("Screenshot limit reached — upgrade for more", false);
      }
    }).then(fn => { unlistenCap = fn; });

    return () => {
      clearInterval(appTimer);
      if (dismissRef.current) clearTimeout(dismissRef.current);
      unlistenCap?.();
    };
  }, []);

  useEffect(() => {
    if (!event) return;
    const dataUrl = event.data_url;
    const limit = isPro ? PRO_LIMIT : FREE_LIMIT;

    // JS-side cap check — catches the case where Rust event arrives before listener is registered
    if (shots.length >= limit && !shots.includes(dataUrl)) {
      if (isPro) {
        showStatus("Supports only 20 images for now", true);
      } else {
        showStatus("Screenshot limit reached — upgrade for more", false);
      }
      return;
    }

    // Optimistic update — show thumbnail immediately, no IPC wait
    setShots(prev => {
      if (prev.includes(dataUrl) || prev.length >= limit) return prev;
      return [...prev, dataUrl];
    });
    setSelected(prev => {
      const shotCount = shots.length;
      if (shots.includes(dataUrl) || shotCount >= limit) return prev;
      return new Set([...prev, shotCount]);
    });
    // Background sync — reconcile with backend state, preserve existing selection
    addSessionScreenshot(dataUrl)
      .then(() => getSessionScreenshots())
      .then(s => {
        setShots(prev => {
          setSelected(prevSel => {
            const n = new Set(prevSel);
            s.forEach((url, i) => {
              if (!prev.includes(url)) n.add(i); // only auto-select truly new images
            });
            return n;
          });
          return s;
        });
      })
      .catch(() => {});

    // Auto-scan new capture for sensitive data
    scanForSensitive(dataUrl).then(isSensitive => {
      if (isSensitive) setSensitiveShots(prev => new Set([...prev, dataUrl]));
    });

    getLastActiveApp().then(app => {
      setActiveApp(app);
      if (app.name) sourcesRef.current.set(dataUrl, app.name);
    }).catch(() => {});
    resetDismissTimer();
  }, [event]);

  function toggleSelect(i: number) {
    setSelected(p => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });
  }

  async function handleClearAll() {
    await clearSessionScreenshots();
    setShots([]);
    setSelected(new Set());
    setSensitiveShots(new Set());
  }

  async function handleRemove(i: number) {
    const removedUrl = shots[i];
    await removeSessionScreenshot(i);
    const s = await getSessionScreenshots();
    setShots(s);
    setSelected(p => {
      const n = new Set<number>();
      p.forEach(x => { if (x !== i) n.add(x > i ? x - 1 : x); });
      return n;
    });
    if (removedUrl) setSensitiveShots(p => { const n = new Set(p); n.delete(removedUrl); return n; });
  }

  const selUrls  = [...selected].sort().map(i => shots[i]).filter(Boolean);
  const selCount = selected.size;
  const isBusy   = busyDest !== null;
  const activeToolName = activeApp.name || "Tool";
  const [pasteHover, setPasteHover] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  isProRef.current = isPro;

  // Always show real thumbnails, including all 20 Pro images. Do not collapse
  // the last slot into a "+N" tile.
  const visibleShots = shots;
  const visibleRows = Math.max(1, Math.ceil(Math.max(visibleShots.length, 1) / COLS));
  const panelHeight = shots.length === 0
    ? PANEL_EMPTY_HEIGHT
    : PANEL_BASE_HEIGHT + (visibleRows - 1) * PANEL_ROW_HEIGHT + (status ? PANEL_STATUS_HEIGHT : 0);
  const [visualPanelHeight, setVisualPanelHeight] = useState(PANEL_EMPTY_HEIGHT);

  useEffect(() => {
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
    }

    if (panelHeight >= nativeHeightRef.current) {
      nativeHeightRef.current = panelHeight;
      resizePanel(panelHeight).catch(() => {});
      requestAnimationFrame(() => setVisualPanelHeight(panelHeight));
      return;
    }

    setVisualPanelHeight(panelHeight);
    resizeTimerRef.current = setTimeout(() => {
      nativeHeightRef.current = panelHeight;
      resizePanel(panelHeight).catch(() => {});
      resizeTimerRef.current = null;
    }, PANEL_TRANSITION_MS);
  }, [panelHeight]);

  function showStatus(msg: string, ok: boolean) {
    setStatus({ msg, ok });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setStatus(null), ok ? 2500 : 10000);
  }

  function pasteErrorMessage(error: unknown) {
    const msg = error instanceof Error ? error.message : String(error || "");
    return msg.length > 120 ? `${msg.slice(0, 117)}...` : msg || "Paste failed.";
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
    } catch (error) { showStatus(pasteErrorMessage(error), false); }
    finally { setBusyDest(null); }
  }

  async function handlePasteTo(dest: typeof DESTINATIONS[0]) {
    if (!selCount) return;
    setBusyDest(dest.id);
    try {
      if (selUrls.length === 1) {
        await pasteToApp(selUrls[0], dest.bundleId);
      } else {
        await pasteSelectedToApp(selUrls, dest.bundleId);
      }
    } catch (error) { showStatus(pasteErrorMessage(error), false); }
    finally { setBusyDest(null); }
  }

  function startPanelDrag(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    void getCurrentWindow().startDragging().catch(() => {});
  }

  async function handleSave() {
    if (!shots.length || savingRef.current) return;
    savingRef.current = true;
    setBusyDest("save");
    let saved = 0;
    try {
      for (const url of shots) {
        const source = sourcesRef.current.get(url) || activeApp.name || "Unknown";
        await saveScreenshot(url, source);
        saved++;
      }
      showStatus(`${saved} image${saved > 1 ? "s" : ""} saved`, true);
    } catch { showStatus("Save failed.", false); }
    finally { savingRef.current = false; setBusyDest(null); }
  }

  async function handleActivate() {
    const key = licenseKey.trim();
    if (!key) { setLicenseError("Please enter your license key."); return; }
    setActivating(true);
    setLicenseError(null);
    try {
      await activateLicense(key);
      setIsPro(true);
      setShowUpgrade(false);
      setLicenseKey("");
      showStatus("Pro unlocked! Enjoy unlimited captures.", true);
    } catch (e) {
      setLicenseError(e instanceof Error ? e.message : String(e));
    } finally {
      setActivating(false);
    }
  }

  return (
    <>
      <div
        className="liquid-panel-material"
        onMouseEnter={() => getCurrentWindow().setFocus().catch(() => {})}
        style={{
          width: PANEL_WIDTH,
          height: visualPanelHeight,
          background: "transparent",
          border: "none",
          borderRadius: 30,
          boxShadow: "none",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
          transition: `height ${PANEL_TRANSITION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
          fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
          color: "var(--panel-text-1)",
        }}
      >
        <div className="liquid-panel-content" style={{ position:"relative" }}>

        {/* Header */}
        <div
          data-tauri-drag-region
          onMouseDown={startPanelDrag}
          style={{
            display:"flex", alignItems:"center", padding:"14px 16px 10px", gap:10,
            cursor:"grab", userSelect:"none",
          }}
        >
          <div
            aria-label="TooEasy"
            role="img"
            style={{
              height:16,
              width:76,
              flex:1,
              background:"var(--panel-text-1)",
              mask:`url(${tooeasyWordmarkUrl}) left center / contain no-repeat`,
              WebkitMask:`url(${tooeasyWordmarkUrl}) left center / contain no-repeat`,
            }}
          />
          {/* Close button */}
          <button
            onClick={() => hidePanel().catch(() => {})}
            title="Close"
            style={{
              width:30, height:30, borderRadius:"50%", flexShrink:0,
              background:"rgba(255,255,255,0.62)", border:"1px solid rgba(31,41,55,0.10)",
              display:"flex", alignItems:"center", justifyContent:"center",
              cursor:"pointer", padding:0,
              boxShadow:"0 6px 16px rgba(17,24,39,0.10), inset 0 1px 0 rgba(255,255,255,0.82)",
            }}
          >
            <Ri icon="ri-close-fill" gradient="linear-gradient(135deg,#4b5563,#111827)" size={14} />
          </button>
        </div>

        {/* Screenshot tray */}
        <div style={{ padding:"8px 16px 10px" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 }}>
            <span className="glass-text" style={{ fontSize:10.5, fontWeight:500, letterSpacing:"0.06em", textTransform:"uppercase", opacity:0.72 }}>
              {shots.length === 0 ? "No captures" : `${shots.length} Image | ${selCount} Selected`}
            </span>
            {shots.length > 0 && (
              <div style={{ display:"flex", gap:4 }}>
                {shots.length > 1 && <>
                  <button onClick={() => setSelected(new Set(shots.map((_,i)=>i)))} style={chipSt}>All</button>
                  <button onClick={() => setSelected(new Set())} style={chipSt}>None</button>
                </>}
                <button onClick={handleClearAll} style={{ ...chipSt, color:"var(--panel-text-1)" }}>Clear</button>
              </div>
            )}
          </div>

          <div style={{
            minHeight:80,
            background:"transparent", borderRadius:14, padding:"3px 2px 10px",
            border:"none", boxShadow:"none",
            display: shots.length === 0 ? "flex" : "grid",
            gridTemplateColumns: shots.length === 0 ? undefined : `repeat(${COLS}, minmax(0, 1fr))`,
            gap:8,
            alignItems: shots.length === 0 ? "center" : "flex-start",
            justifyContent: shots.length === 0 ? "center" : "flex-start",
          }}>
            {shots.length === 0 ? (
              <span className="glass-text" style={{ fontSize:13, fontWeight:500, opacity:0.72 }}>Take a screenshot to begin</span>
            ) : visibleShots.map((url, i) => {
              const isSel = selected.has(i);
              return (
                <div
                  key={i}
                  className="shot-tile"
                  data-selected={isSel}
                  onClick={() => toggleSelect(i)}
                  style={{
                    position:"relative", minWidth:0, cursor:"pointer",
                    padding:3, borderRadius:12,
                    background: isSel ? "rgba(34,197,94,0.22)" : "rgba(255,255,255,0.08)",
                    border: isSel ? "2px solid rgba(34,197,94,0.80)" : "1px solid rgba(255,255,255,0.20)",
                    boxShadow: isSel
                      ? "0 7px 18px rgba(34,197,94,0.18), inset 0 1px 0 rgba(34,197,94,0.30)"
                      : "inset 0 1px 0 rgba(255,255,255,0.18)",
                  }}
                >
                  <div style={{
                    width:"100%", height:56, borderRadius:9, overflow:"hidden", position:"relative",
                    boxShadow:"0 4px 10px rgba(31,38,62,0.13)",
                  }}>
                    <img src={url} decoding="async" style={{
                      width:"100%", height:"100%", objectFit:"cover", display:"block",
                      filter: sensitiveShots.has(url) ? "blur(14px) brightness(0.7)" : "none",
                    }}/>
                    {sensitiveShots.has(url) && (
                      <div style={{
                        position:"absolute", inset:0,
                        display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2,
                        background:"rgba(239,68,68,0.20)",
                        border:"1px solid rgba(239,68,68,0.50)",
                        pointerEvents:"none",
                      }}>
                        <i className="ri-shield-fill" style={{ fontSize:13, color:"#ef4444", WebkitTextFillColor:"#ef4444" }} />
                        <span style={{ fontSize:8, fontWeight:700, color:"#ef4444", letterSpacing:"0.04em" }}>SENSITIVE</span>
                      </div>
                    )}
                  </div>
                  <button className="shot-action" onClick={e => { e.stopPropagation(); handleRemove(i); }} style={{
                    position:"absolute", top:5, right:5, width:18, height:18,
                    borderRadius:6, background:"rgba(239,68,68,0.92)",
                    border:"1px solid rgba(255,255,255,0.72)", color:"white",
                    cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center",
                    padding:0, boxShadow:"0 4px 12px rgba(0,0,0,0.18)",
                  }}>
                    <i className="ri-close-fill" style={{ fontSize:10, color:"white", WebkitTextFillColor:"white", lineHeight:1 }} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* License key modal */}
          {showUpgrade && (
            <div style={{
              position:"absolute", inset:0, zIndex:100,
              background:"rgba(15,17,24,0.72)", backdropFilter:"blur(12px)",
              borderRadius:30, display:"flex", flexDirection:"column",
              alignItems:"center", justifyContent:"center", padding:"28px 24px", gap:0,
            }}>
              {/* Close */}
              <button
                onClick={() => { setShowUpgrade(false); setLicenseKey(""); setLicenseError(null); }}
                style={{
                  position:"absolute", top:16, right:16,
                  width:28, height:28, borderRadius:"50%",
                  background:"rgba(255,255,255,0.12)", border:"1px solid rgba(255,255,255,0.18)",
                  display:"flex", alignItems:"center", justifyContent:"center",
                  cursor:"pointer", padding:0,
                }}
              >
                <Ri icon="ri-close-fill" gradient="linear-gradient(135deg,#d1d5db,#9ca3af)" size={13} />
              </button>

              {/* Icon */}
              <div style={{
                width:48, height:48, borderRadius:16,
                background:"rgba(255,255,255,0.16)",
                display:"flex", alignItems:"center", justifyContent:"center",
                marginBottom:14,
                boxShadow:"0 8px 24px rgba(17,24,39,0.20)",
              }}>
                <i className="ri-key-2-fill" style={{ fontSize:22, color:"white", WebkitTextFillColor:"white", lineHeight:1 }} />
              </div>

              <p style={{ margin:"0 0 4px", fontSize:15, fontWeight:700, color:"white", textAlign:"center" }}>
                Unlock TooEasy Pro
              </p>
              <p style={{ margin:"0 0 18px", fontSize:11.5, color:"rgba(255,255,255,0.52)", textAlign:"center", lineHeight:1.4 }}>
                Up to 20 captures per session
              </p>

              {/* Key input */}
              <input
                value={licenseKey}
                onChange={e => { setLicenseKey(e.target.value); setLicenseError(null); }}
                onKeyDown={e => { if (e.key === "Enter") handleActivate(); }}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                autoFocus
                style={{
                  width:"100%", height:38, borderRadius:10,
                  background:"rgba(255,255,255,0.09)", border:`1px solid ${licenseError ? "rgba(239,68,68,0.7)" : "rgba(255,255,255,0.20)"}`,
                  color:"white", fontSize:12.5, fontFamily:"'SF Mono', monospace",
                  padding:"0 12px", outline:"none", boxSizing:"border-box",
                  letterSpacing:"0.06em", marginBottom:licenseError ? 6 : 10,
                }}
              />
              {licenseError && (
                <p style={{ margin:"0 0 10px", fontSize:11, color:"rgba(239,68,68,0.9)", textAlign:"center" }}>
                  {licenseError}
                </p>
              )}

              {/* Activate button */}
              <button
                onClick={handleActivate}
                disabled={activating}
                style={{
                  width:"100%", height:40, borderRadius:10,
                  background:"#ffffff",
                  border:"none", color:"#20242e", fontSize:13, fontWeight:600,
                  cursor: activating ? "default" : "pointer",
                  opacity: activating ? 0.7 : 1,
                  marginBottom:12,
                  boxShadow:"0 6px 18px rgba(17,24,39,0.18)",
                  fontFamily:"inherit",
                }}
              >
                {activating ? "Activating…" : "Activate License"}
              </button>

              {/* Buy link */}
              <button
                onClick={() => openUrl(PURCHASE_URL).catch(() => {})}
                style={{
                  background:"none", border:"none", padding:0,
                  fontSize:11.5, color:"rgba(255,255,255,0.82)", cursor:"pointer",
                  textDecoration:"underline", fontFamily:"inherit",
                }}
              >
                Don't have a key? Buy TooEasy Pro →
              </button>
            </div>
          )}
        </div>

        {/* Primary paste */}
        <div style={{ padding:"8px 16px 0" }}>
          <button
            onClick={handlePasteOnTool}
            disabled={!selCount || isBusy || !activeApp.bundle_id}
            onMouseEnter={() => setPasteHover(true)}
            onMouseLeave={() => setPasteHover(false)}
            style={{
              width:"100%", height:48,
              background: "#ffffff",
              border:"none", borderRadius:999,
              color:"#20242e",
              fontSize:15, fontWeight:500,
              cursor: selCount && !isBusy && activeApp.bundle_id ? "pointer" : "default",
              display:"flex", alignItems:"center", justifyContent:"center", gap:6,
              fontFamily:"inherit",
              boxShadow: pasteHover
                ? "0 12px 28px rgba(17,24,39,0.16), 0 3px 8px rgba(17,24,39,0.10), inset 0 1px 0 rgba(255,255,255,0.95)"
                : "0 8px 22px rgba(17,24,39,0.13), 0 2px 5px rgba(17,24,39,0.08), inset 0 1px 0 rgba(255,255,255,0.95)",
              opacity: !selCount || isBusy || !activeApp.bundle_id ? 0.45 : 1,
              transition:"box-shadow 150ms ease, opacity 150ms ease",
              minWidth:0, whiteSpace:"nowrap", overflow:"hidden",
            }}
          >
            <span style={{ overflow:"hidden", textOverflow:"ellipsis" }}>
              {busyDest==="active-tool" ? "Pasting…" : `Paste on ${activeToolName}`}
            </span>
          </button>
        </div>

        {/* Secondary actions */}
        <div style={{ padding:"16px 16px 22px", display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <button onClick={handleSave} disabled={!selCount || isBusy} title="Save to gallery" style={secondaryButtonStyle(selCount > 0 && !isBusy)}>
            {busyDest === "save"
              ? <Ri icon="ri-check-fill" gradient="linear-gradient(135deg,#10b981,#34d399)" size={16} />
              : <Ri icon="ri-bookmark-fill" gradient="linear-gradient(135deg,#111827,#4b5563)" size={16} />
            }
            <span className="glass-text" style={{ fontSize:12, fontWeight:500, opacity:0.82 }}>Save</span>
          </button>
          <button onClick={() => { showGallery().catch(()=>{}); }} style={secondaryButtonStyle(true)}>
            <i className="ri-gallery-view-2" style={{ fontSize:14, color:"var(--panel-icon)", WebkitTextFillColor:"var(--panel-icon)", lineHeight:1 }} />
            <span className="glass-text" style={{ fontSize:12, fontWeight:500, opacity:0.82 }}>Gallery</span>
          </button>
        </div>

        {/* Quick paste destinations */}
        <div style={{ padding:"0 16px 20px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>
            <div style={{ flex:1, height:1, background:"rgba(255,255,255,0.18)" }} />
            <span className="glass-text" style={{ fontSize:10, fontWeight:500, opacity:0.45, letterSpacing:"0.05em" }}>PASTE TO</span>
            <div style={{ flex:1, height:1, background:"rgba(255,255,255,0.18)" }} />
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            {DESTINATIONS.map(dest => (
              <button
                key={dest.id}
                onClick={() => handlePasteTo(dest)}
                disabled={!selCount || isBusy}
                title={`Paste to ${dest.name}`}
                style={{
                  height:36,
                  background:"rgba(255,255,255,0.28)",
                  border:"1px solid rgba(255,255,255,0.40)",
                  borderRadius:12,
                  cursor: selCount && !isBusy ? "pointer" : "default",
                  display:"flex", alignItems:"center", justifyContent:"center", gap:5,
                  opacity: !selCount || isBusy ? 0.4 : 1,
                  transition:"background 120ms ease, opacity 150ms ease",
                  boxShadow: busyDest === dest.id
                    ? "0 0 0 2px rgba(255,255,255,0.55)"
                    : "inset 0 1px 0 rgba(255,255,255,0.46)",
                }}
              >
                <img src={dest.logo} alt={dest.name} style={{ width:14, height:14, objectFit:"contain" }} />
                <span className="glass-text" style={{ fontSize:11, fontWeight:500, opacity:0.80 }}>{dest.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Guidance text */}
        <div style={{ padding:"0 18px 28px" }}>
          <p style={{ margin:0, fontSize:10.5, lineHeight:1.5, textAlign:"center", opacity:0.40 }}
            className="glass-text">
            Paste works best with a focused text input
          </p>
        </div>

        {/* Status toast */}
        {status && (
          <div style={{
            margin:"8px 20px 20px", padding:"10px 12px",
            background: status.ok ? "rgba(220,252,231,0.50)" : "rgba(254,226,226,0.52)",
            border:`1px solid ${status.ok ? "rgba(34,197,94,0.28)" : "rgba(239,68,68,0.28)"}`,
            borderRadius:13, fontSize:12,
            color: status.ok ? "#15803d" : "#dc2626",
            boxShadow:"inset 0 1px 0 rgba(255,255,255,0.38)",
            display:"flex", alignItems:"center", justifyContent:"center", gap:6,
            minHeight:40,
            lineHeight:1.35,
            textAlign:"center",
          }}>
            <span style={{ minWidth:0, overflowWrap:"anywhere" }}>{status.msg}</span>
            {!status.ok && !isPro && status.msg.includes("upgrade") && (
              <button
                onClick={() => { openUrl(PURCHASE_URL).catch(() => {}); }}
                style={{
                  background:"rgba(239,68,68,0.18)", border:"1px solid rgba(239,68,68,0.35)",
                  borderRadius:6, padding:"2px 8px", fontSize:11, fontWeight:600,
                  color:"#dc2626", cursor:"pointer", fontFamily:"inherit", flexShrink:0,
                }}
              >Upgrade</button>
            )}
          </div>
        )}
        </div>
      </div>
    </>
  );
}

// ── Brand assets ─────────────────────────────────────────────────────────────
import tooeasyWordmarkUrl from "../assets/logos/tooeasy-wordmark.svg";
import claudeLogoUrl from "../assets/logos/claude.svg";
import chatgptLogoUrl from "../assets/logos/chatgpt.svg";
import figmaLogoUrl from "../assets/logos/figma.svg";
import chromeLogoUrl from "../assets/logos/chrome.svg";

const DESTINATIONS = [
  { id: "claude",  bundleId: "com.anthropic.claudefordesktop", name: "Claude",  logo: claudeLogoUrl },
  { id: "chatgpt", bundleId: "com.openai.chat",                name: "ChatGPT", logo: chatgptLogoUrl },
  { id: "figma",   bundleId: "com.figma.Desktop",              name: "Figma",   logo: figmaLogoUrl },
  { id: "chrome",  bundleId: "com.google.Chrome",              name: "Chrome",  logo: chromeLogoUrl },
];


// ── Shared styles ─────────────────────────────────────────────────────────────
const chipSt: React.CSSProperties = {
  height:19, padding:"0 8px",
  background:"rgba(255,255,255,0.38)", border:"1px solid rgba(255,255,255,0.46)",
  borderRadius:999, color:"var(--panel-text-2)",
  fontSize:10, fontWeight:500, cursor:"pointer",
  boxShadow:"inset 0 1px 0 rgba(255,255,255,0.46)",
};

function secondaryButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    height:34,
    background:"rgba(255,255,255,0.34)",
    border:"1px solid rgba(255,255,255,0.46)",
    borderRadius:999,
    cursor: enabled ? "pointer" : "default",
    fontFamily:"inherit",
    display:"flex",
    alignItems:"center",
    justifyContent:"center",
    gap:6,
    padding:"0 12px",
    opacity: enabled ? 1 : 0.45,
    boxShadow:"inset 0 1px 0 rgba(255,255,255,0.46)",
  };
}
