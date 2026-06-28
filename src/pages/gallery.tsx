import { useEffect, useState } from "react";
import { editScreenshot, listScreenshots, onScreenshotsUpdated, trashScreenshot } from "../lib/tauri";
import type { ScreenshotItem } from "../lib/tauri";
import AnnotationCanvas from "../components/AnnotationCanvas";

function Ri({ icon, gradient, size = 16, style }: { icon: string; gradient: string; size?: number; style?: React.CSSProperties }) {
  return (
    <i className={icon} style={{
      fontSize: size,
      background: gradient,
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
      backgroundClip: "text",
      lineHeight: 1,
      display: "inline-block",
      ...style,
    }} />
  );
}

type Filter = "all" | "today" | "yesterday" | "week" | "month" | "trash";
type Tab = "gallery" | "settings";

function isToday(d: string) {
  return d.startsWith(new Date().toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" }));
}
function isYesterday(d: string) {
  const y = new Date(); y.setDate(y.getDate()-1);
  return d.startsWith(y.toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" }));
}
function isThisWeek(d: string) {
  const w = new Date(); w.setDate(w.getDate()-7);
  return new Date(d) >= w;
}
function isThisMonth(d: string) {
  const m = new Date(); m.setMonth(m.getMonth()-1);
  return new Date(d) >= m;
}

function groupByDate(items: ScreenshotItem[]) {
  const groups: Record<string, ScreenshotItem[]> = {};
  for (const item of items) {
    const parts = item.captured_at.split(" ");
    const key = parts.slice(0, -2).join(" ");
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return Object.entries(groups).map(([label, items]) => ({ label, items }));
}

export default function GalleryPage() {
  const [tab, setTab]           = useState<Tab>("gallery");
  const [filter, setFilter]     = useState<Filter>("all");
  const [screenshots, setShots] = useState<ScreenshotItem[]>([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState("");
  const [busyPath, setBusy]     = useState<string|null>(null);
  const [annotating, setAnnotating] = useState<ScreenshotItem|null>(null);
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem("onboarded") === "1");

  function refresh() {
    listScreenshots().then(setShots).catch(console.error).finally(() => setLoading(false));
  }
  useEffect(() => {
    refresh();
    let u: (()=>void)|null = null;
    onScreenshotsUpdated(refresh).then(fn => { u = fn; });
    window.addEventListener("focus", refresh);
    return () => { u?.(); window.removeEventListener("focus", refresh); };
  }, []);

  async function handleEdit(fp: string) {
    setBusy(fp); try { await editScreenshot(fp); } catch {} finally { setBusy(null); }
  }
  async function handleTrash(s: ScreenshotItem) {
    setBusy(s.filepath); try { await trashScreenshot(s.filepath); refresh(); } catch {} finally { setBusy(null); }
  }

  const todayCount     = screenshots.filter(s => isToday(s.captured_at)).length;
  const yesterdayCount = screenshots.filter(s => isYesterday(s.captured_at)).length;
  const weekCount      = screenshots.filter(s => isThisWeek(s.captured_at)).length;
  const monthCount     = screenshots.length;

  const filtered = screenshots.filter(s => {
    if (search && !s.filename.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === "today")     return isToday(s.captured_at);
    if (filter === "yesterday") return isYesterday(s.captured_at);
    if (filter === "week")      return isThisWeek(s.captured_at);
    if (filter === "month")     return isThisMonth(s.captured_at);
    return true;
  });
  const groups = groupByDate(filtered);

  if (!onboarded) {
    return <Onboarding onDone={() => { localStorage.setItem("onboarded","1"); setOnboarded(true); }} />;
  }

  return (
    <div className="gallery-bg" style={{ height:"100vh", display:"flex", flexDirection:"column" }}>
      {/* Titlebar */}
      <div data-tauri-drag-region className="titlebar-glass"
        style={{ height:52, display:"flex", alignItems:"center", padding:"0 20px", gap:16, flexShrink:0,
          WebkitAppRegion:"drag" } as React.CSSProperties}>
        {/* Logo */}
        <div style={{ display:"flex", alignItems:"center", gap:9, WebkitAppRegion:"no-drag" } as React.CSSProperties}>
          <div style={{ width:28, height:28, borderRadius:8,
            background:"linear-gradient(145deg,#6366f1,#4F6BF0)",
            display:"flex", alignItems:"center", justifyContent:"center",
            boxShadow:"0 2px 8px rgba(79,107,240,0.35)" }}>
            <i className="ri-camera-fill" style={{ fontSize:15, color:"white", WebkitTextFillColor:"white" }} />
          </div>
          <span style={{ fontSize:14, fontWeight:600, color:"#1c1c1e", letterSpacing:"-0.02em" }}>TooEasy</span>
        </div>

        {/* Search */}
        {tab === "gallery" && (
          <div style={{ flex:1, maxWidth:360, WebkitAppRegion:"no-drag" } as React.CSSProperties}>
            <div style={{ position:"relative" }}>
              <Ri icon="ri-search-line" gradient="linear-gradient(135deg,#a78bfa,#6366f1)" size={13} style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)" }} />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search screenshots…"
                style={{ width:"100%", height:32, paddingLeft:30, paddingRight:12,
                  background:"#fff", border:"1px solid rgba(0,0,0,0.08)",
                  borderRadius:8, fontSize:13, color:"#1c1c1e", outline:"none",
                  boxShadow:"0 1px 2px rgba(0,0,0,0.05)" }} />
            </div>
          </div>
        )}

        <div style={{ flex:1 }} data-tauri-drag-region />

        {/* Tabs */}
        <div style={{ display:"flex", gap:2, WebkitAppRegion:"no-drag" } as React.CSSProperties}>
          {(["gallery","settings"] as Tab[]).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              height:28, padding:"0 12px", borderRadius:6, border:"none",
              background: tab===t ? "#fff" : "transparent",
              color: tab===t ? "#1c1c1e" : "#6b7280",
              fontSize:13, fontWeight: tab===t ? 600 : 400,
              cursor:"pointer", boxShadow: tab===t ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
              textTransform:"capitalize",
            }}>{t}</button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
        {tab === "gallery" ? (
          <>
            {/* Left sidebar */}
            <div style={{ width:200, flexShrink:0, padding:"16px 12px", borderRight:"1px solid rgba(0,0,0,0.06)", overflowY:"auto" }}>
              {[
                { id:"all",       label:"All Screenshots", count:monthCount,     icon:"ri-image-fill",           gradient:"linear-gradient(135deg,#6366f1,#818cf8)" },
                { id:"today",     label:"Today",           count:todayCount,     icon:"ri-calendar-fill",        gradient:"linear-gradient(135deg,#f97316,#fb923c)" },
                { id:"yesterday", label:"Yesterday",       count:yesterdayCount, icon:"ri-time-fill",            gradient:"linear-gradient(135deg,#06b6d4,#38bdf8)" },
                { id:"week",      label:"This Week",       count:weekCount,      icon:"ri-calendar-2-fill",      gradient:"linear-gradient(135deg,#10b981,#34d399)" },
                { id:"month",     label:"This Month",      count:monthCount,     icon:"ri-calendar-check-fill",  gradient:"linear-gradient(135deg,#ec4899,#f472b6)" },
              ].map(item => (
                <button key={item.id} onClick={() => setFilter(item.id as Filter)}
                  className={`sidebar-item ${filter===item.id?"active":""}`}
                  style={{ width:"100%", textAlign:"left", border:"none", display:"flex", alignItems:"center", gap:8, padding:"7px 10px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", marginBottom:2 }}>
                  <Ri icon={item.icon} gradient={item.gradient} size={15} />
                  <span style={{ flex:1, fontSize:13, fontWeight:500 }}>{item.label}</span>
                  <span style={{ fontSize:12, color:"#9ca3af" }}>{item.count}</span>
                </button>
              ))}

              <div style={{ height:1, background:"rgba(0,0,0,0.06)", margin:"10px 0" }} />

              <div style={{ padding:"4px 6px 8px", fontSize:11, fontWeight:600, color:"#9ca3af", textTransform:"uppercase", letterSpacing:"0.06em" }}>
                Storage
              </div>
              <div style={{ padding:"8px 10px", background:"#fff", borderRadius:10, boxShadow:"0 1px 3px rgba(0,0,0,0.07)" }}>
                <div style={{ fontSize:12, fontWeight:600, color:"#1c1c1e", marginBottom:6 }}>
                  {screenshots.length} captures
                </div>
                <div style={{ height:4, background:"#f0f1f7", borderRadius:999, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:"22%", background:"linear-gradient(90deg,#4F6BF0,#6366f1)", borderRadius:999 }} />
                </div>
              </div>
            </div>

            {/* Main grid */}
            <div style={{ flex:1, overflowY:"auto", padding:"20px 20px" }}>
              {loading ? (
                <div style={{ textAlign:"center", padding:64, color:"#9ca3af" }}>Loading…</div>
              ) : filtered.length === 0 ? (
                <EmptyState message={search ? "No results." : undefined} />
              ) : (
                groups.map(({ label, items }) => (
                  <section key={label} style={{ marginBottom:32 }}>
                    <h2 style={{ fontSize:16, fontWeight:600, color:"#1c1c1e", marginBottom:14 }}>{label}</h2>
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:12 }}>
                      {items.map(s => (
                        <ScreenshotCard key={s.filepath} screenshot={s}
                          busy={busyPath===s.filepath}
                          onEdit={() => handleEdit(s.filepath)}
                          onTrash={() => handleTrash(s)}
                          onAnnotate={() => setAnnotating(s)} />
                      ))}
                    </div>
                  </section>
                ))
              )}
            </div>
          </>
        ) : (
          <div style={{ flex:1, overflowY:"auto" }}>
            <SettingsTab />
          </div>
        )}
      </div>

      {annotating && <AnnotationCanvas screenshot={annotating} onClose={() => setAnnotating(null)} />}
    </div>
  );
}

// ── Screenshot card ──────────────────────────────────────────────────────────
function ScreenshotCard({ screenshot, busy, onEdit, onTrash, onAnnotate }: {
  screenshot: ScreenshotItem; busy: boolean;
  onEdit: ()=>void; onTrash: ()=>void; onAnnotate: ()=>void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <article className="screenshot-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}>
      <div style={{ aspectRatio:"16/10", background:"#f0f1f7", position:"relative", overflow:"hidden" }}>
        <img src={screenshot.data_url} alt={screenshot.filename}
          style={{ width:"100%", height:"100%", objectFit:"cover" }} />
        {hovered && (
          <div style={{ position:"absolute", inset:0,
            background:"linear-gradient(to bottom, transparent 40%, rgba(0,0,0,0.55))",
            display:"flex", alignItems:"flex-end", padding:8, gap:5 }}>
            <button onClick={onAnnotate} style={overlayBtn("#fff","#1c1c1e")}>Annotate</button>
            <button onClick={onEdit}     style={overlayBtn("rgba(255,255,255,0.20)","#fff")}>Open</button>
          </div>
        )}
      </div>
      <div style={{ padding:"9px 11px 10px" }}>
        <div style={{ fontSize:12, fontWeight:600, color:"#1c1c1e",
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", marginBottom:4 }}>
          {screenshot.filename}
        </div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:5 }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:"#9ca3af" }} />
            <span style={{ fontSize:11, color:"#9ca3af" }}>{screenshot.captured_at}</span>
          </div>
          <button onClick={onTrash} disabled={busy}
            style={{ background:"none", border:"none", cursor:busy?"default":"pointer",
              color:"#d1d5db", fontSize:16, padding:2, lineHeight:1, transition:"color 120ms" }}
            onMouseEnter={e => (e.currentTarget.style.color="#ef4444")}
            onMouseLeave={e => (e.currentTarget.style.color="#d1d5db")}>
            <Ri icon={busy ? "ri-loader-4-line" : "ri-delete-bin-fill"} gradient="linear-gradient(135deg,#ef4444,#f97316)" size={16} />
          </button>
        </div>
      </div>
    </article>
  );
}

function overlayBtn(bg: string, color: string): React.CSSProperties {
  return {
    padding:"4px 10px", borderRadius:6, border:"none",
    background:bg, color, fontSize:11, fontWeight:600, cursor:"pointer",
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────
function SettingsTab() {
  const [notifications, setNotifications] = useState(true);
  const [autoSave, setAutoSave]           = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(true);
  const [showBubble, setShowBubble]       = useState(() => localStorage.getItem("te_bubble") === "1");
  const [autoDismiss, setAutoDismiss]     = useState(() => localStorage.getItem("te_autoDismiss") !== "0");
  const [dismissTimer, setDismissTimer]   = useState(() => Number(localStorage.getItem("te_dismissTimer") ?? 30));

  useEffect(() => { localStorage.setItem("te_bubble", showBubble ? "1" : "0"); }, [showBubble]);
  useEffect(() => { localStorage.setItem("te_autoDismiss", autoDismiss ? "1" : "0"); }, [autoDismiss]);
  useEffect(() => { localStorage.setItem("te_dismissTimer", String(dismissTimer)); }, [dismissTimer]);

  const timerOptions = [10, 15, 30, 60, 120];

  return (
    <div style={{ padding:"28px 28px", maxWidth:580, margin:"0 auto" }}>
      <h1 style={{ fontSize:20, fontWeight:600, color:"#1c1c1e", marginBottom:4 }}>Settings</h1>
      <p style={{ fontSize:13, color:"#9ca3af", marginBottom:24 }}>Manage your TooEasy preferences.</p>

      {/* Profile */}
      <div className="settings-card" style={{ padding:"14px 16px", marginBottom:16, display:"flex", alignItems:"center", gap:14 }}>
        <div style={{ width:44, height:44, borderRadius:12,
          background:"linear-gradient(145deg,#6366f1,#4F6BF0)",
          display:"flex", alignItems:"center", justifyContent:"center" }}>
          <i className="ri-user-fill" style={{ fontSize:22, color:"white", WebkitTextFillColor:"white" }} />
        </div>
        <div>
          <div style={{ fontSize:14, fontWeight:600 }}>Your Account</div>
          <div style={{ fontSize:12, color:"#9ca3af" }}>Free plan · Upgrade for unlimited captures</div>
        </div>
        <div style={{ flex:1 }} />
        <button style={{ height:32, padding:"0 14px", borderRadius:8,
          background:"linear-gradient(135deg,#6366f1,#4F6BF0)", border:"none",
          color:"white", fontSize:13, fontWeight:600, cursor:"pointer" }}>Upgrade</button>
      </div>

      <SectionLabel>General</SectionLabel>
      <div className="settings-card" style={{ marginBottom:16 }}>
        <ToggleRow label="Launch at Login" desc="Start TooEasy automatically" value={launchAtLogin} onChange={setLaunchAtLogin} />
        <div style={{ height:1, background:"#f4f4f5" }} />
        <ToggleRow label="Auto-save to Gallery" desc="Save every screenshot automatically" value={autoSave} onChange={setAutoSave} />
        <div style={{ height:1, background:"#f4f4f5" }} />
        <ToggleRow label="Notifications" desc="Show notification on capture" value={notifications} onChange={setNotifications} />
      </div>

      <SectionLabel>Panel Behavior</SectionLabel>
      <div className="settings-card" style={{ marginBottom:16 }}>
        <ToggleRow
          label="Auto-dismiss Panel"
          desc="Automatically hide panel after inactivity"
          value={autoDismiss}
          onChange={setAutoDismiss}
        />
        {autoDismiss && (
          <>
            <div style={{ height:1, background:"#f4f4f5" }} />
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 16px" }}>
              <div>
                <div style={{ fontSize:13, fontWeight:500, color:"#1c1c1e" }}>Dismiss After</div>
                <div style={{ fontSize:12, color:"#9ca3af", marginTop:1 }}>Hide panel after this many seconds</div>
              </div>
              <div style={{ display:"flex", gap:5 }}>
                {timerOptions.map(sec => (
                  <button key={sec} onClick={() => setDismissTimer(sec)} style={{
                    height:28, padding:"0 10px", borderRadius:7, cursor:"pointer",
                    fontFamily:"inherit", fontSize:12, fontWeight:600,
                    background: dismissTimer === sec ? "#4F6BF0" : "#f4f4f5",
                    color: dismissTimer === sec ? "#fff" : "#6b7280",
                    border: dismissTimer === sec ? "none" : "1px solid rgba(0,0,0,0.08)",
                    transition:"background 120ms",
                  }}>
                    {sec >= 60 ? `${sec/60}m` : `${sec}s`}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        <div style={{ height:1, background:"#f4f4f5" }} />
        <ToggleRow
          label="Show Bubble"
          desc="Show floating bubble for quick access (like iOS AssistiveTouch)"
          value={showBubble}
          onChange={setShowBubble}
        />
      </div>

      <SectionLabel>Keyboard Shortcuts</SectionLabel>
      <div className="settings-card" style={{ marginBottom:16 }}>
        {[
          { label:"Copy to clipboard (instant)", key:"⌃⌘⇧4" },
          { label:"Save to Desktop (~5s delay)", key:"⌘⇧4" },
          { label:"Open gallery",                key:"⌘⇧G" },
        ].map((s, i, arr) => (
          <div key={s.label}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 16px" }}>
              <span style={{ fontSize:13, color:"#1c1c1e" }}>{s.label}</span>
              <kbd style={{ padding:"3px 9px", borderRadius:6, background:"#f4f4f5",
                border:"1px solid rgba(0,0,0,0.08)", fontSize:12, color:"#6b7280", fontFamily:"inherit" }}>{s.key}</kbd>
            </div>
            {i < arr.length-1 && <div style={{ height:1, background:"#f4f4f5" }} />}
          </div>
        ))}
      </div>

      <SectionLabel>About</SectionLabel>
      <div className="settings-card" style={{ padding:"16px", textAlign:"center" }}>
        <div style={{ fontSize:13, fontWeight:600, marginBottom:2 }}>TooEasy</div>
        <div style={{ fontSize:12, color:"#9ca3af" }}>Version 1.0.0</div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize:11, fontWeight:600, color:"#9ca3af", textTransform:"uppercase",
    letterSpacing:"0.06em", marginBottom:6, marginTop:4 }}>{children}</div>;
}

function ToggleRow({ label, desc, value, onChange }: { label:string; desc:string; value:boolean; onChange:(v:boolean)=>void }) {
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 16px", gap:16 }}>
      <div>
        <div style={{ fontSize:13, fontWeight:500, color:"#1c1c1e" }}>{label}</div>
        <div style={{ fontSize:12, color:"#9ca3af", marginTop:1 }}>{desc}</div>
      </div>
      <div onClick={() => onChange(!value)} style={{
        width:40, height:24, borderRadius:999, cursor:"pointer", flexShrink:0,
        background: value ? "#4F6BF0" : "#e4e4e7",
        position:"relative", transition:"background 200ms",
      }}>
        <div style={{
          position:"absolute", top:3, left: value ? 19 : 3,
          width:18, height:18, borderRadius:"50%", background:"#fff",
          boxShadow:"0 1px 3px rgba(0,0,0,0.25)",
          transition:"left 200ms cubic-bezier(0.34,1.56,0.64,1)",
        }} />
      </div>
    </div>
  );
}

function EmptyState({ message }: { message?: string }) {
  return (
    <div style={{ textAlign:"center", padding:"80px 32px", color:"#9ca3af" }}>
      <Ri icon="ri-screenshot-fill" gradient="linear-gradient(135deg,#a78bfa,#6366f1)" size={48} style={{ display:"block", marginBottom:12 }} />
      <div style={{ fontSize:15, fontWeight:600, marginBottom:6, color:"#6b7280" }}>{message ?? "No screenshots yet"}</div>
      <div style={{ fontSize:13 }}>Press ⌃⌘⇧4 to capture your screen instantly</div>
    </div>
  );
}

// ── Onboarding ────────────────────────────────────────────────────────────────
function Onboarding({ onDone }: { onDone: ()=>void }) {
  const [step, setStep] = useState(0);
  const steps = [
    {
      title: "Two ways to capture",
      custom: <CaptureOptions />,
    },
    {
      title: "Bundle & paste",
      body: "Take multiple screenshots, select them all, then send to Claude, ChatGPT, or Figma in one click.",
    },
    {
      title: "Saved to your gallery",
      body: "Every screenshot is saved. Browse, annotate, and re-send any capture from the gallery.",
    },
  ];
  const s = steps[step];
  const isLast = step === steps.length - 1;

  return (
    <div style={{ minHeight:"100vh", background:"#f0f1f7",
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:32 }}>
      <div style={{ width:400 }}>
        {/* Logo */}
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <div style={{ width:60, height:60, borderRadius:16, margin:"0 auto 12px",
            background:"linear-gradient(145deg,#6366f1,#4F6BF0)",
            display:"flex", alignItems:"center", justifyContent:"center",
            boxShadow:"0 6px 24px rgba(79,107,240,0.40)" }}>
            <i className="ri-camera-fill" style={{ fontSize:28, color:"white", WebkitTextFillColor:"white" }} />
          </div>
          <div style={{ fontSize:22, fontWeight:600, color:"#1c1c1e" }}>TooEasy</div>
        </div>

        {/* Card */}
        <div key={step} style={{ background:"#fff", borderRadius:20,
          padding:"28px 24px", marginBottom:20,
          boxShadow:"0 4px 24px rgba(0,0,0,0.09)",
          animation:"fade-up 260ms cubic-bezier(0.34,1.56,0.64,1) forwards" }}>
          <h2 style={{ fontSize:18, fontWeight:600, color:"#1c1c1e", marginBottom:10 }}>{s.title}</h2>
          {s.body && <p style={{ fontSize:14, color:"#6b7280", lineHeight:1.65 }}>{s.body}</p>}
          {s.custom}
        </div>

        {/* Dots */}
        <div style={{ display:"flex", justifyContent:"center", gap:6, marginBottom:16 }}>
          {steps.map((_,i) => (
            <div key={i} style={{ width: i===step ? 18 : 6, height:6, borderRadius:999,
              background: i===step ? "#4F6BF0" : "#d1d5db",
              transition:"all 280ms cubic-bezier(0.34,1.56,0.64,1)" }} />
          ))}
        </div>

        {/* CTA */}
        <button onClick={() => isLast ? onDone() : setStep(step+1)} style={{
          width:"100%", height:48, borderRadius:12,
          background:"linear-gradient(135deg,#6366f1,#4F6BF0)", border:"none",
          color:"white", fontSize:15, fontWeight:600, cursor:"pointer",
          boxShadow:"0 4px 16px rgba(79,107,240,0.40)",
        }}>{isLast ? "Get started" : "Continue"}</button>

        {step > 0 && (
          <button onClick={() => setStep(step-1)} style={{
            width:"100%", marginTop:10, background:"none", border:"none",
            color:"#9ca3af", fontSize:13, cursor:"pointer" }}>Back</button>
        )}
      </div>
    </div>
  );
}

function CaptureOptions() {
  const opts = [
    { keys:["⌃","⌘","⇧","4"], label:"Copy to clipboard", badge:"Instant", badgeColor:"#4F6BF0",
      desc:"Caught by TooEasy immediately." },
    { keys:["⌘","⇧","4"], label:"Save to Desktop", badge:"~5 sec delay", badgeColor:"#9ca3af",
      desc:"TooEasy picks it up within a few seconds." },
  ];
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      {opts.map(opt => (
        <div key={opt.label} style={{ background:"#f9f9fb", borderRadius:12, padding:"12px 14px" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
            <div style={{ display:"flex", gap:4 }}>
              {opt.keys.map(k => (
                <kbd key={k} style={{ padding:"3px 7px", borderRadius:6,
                  background:"#fff", border:"1px solid rgba(0,0,0,0.12)",
                  fontSize:13, fontWeight:600, color:"#1c1c1e", fontFamily:"inherit",
                  boxShadow:"0 1px 0 rgba(0,0,0,0.15)" }}>{k}</kbd>
              ))}
            </div>
            <span style={{ fontSize:10, fontWeight:600, color:opt.badgeColor,
              background:`${opt.badgeColor}18`, border:`1px solid ${opt.badgeColor}30`,
              padding:"2px 8px", borderRadius:999, letterSpacing:"0.04em", textTransform:"uppercase" }}>
              {opt.badge}
            </span>
          </div>
          <div style={{ fontSize:13, fontWeight:600, color:"#1c1c1e", marginBottom:2 }}>{opt.label}</div>
          <div style={{ fontSize:12, color:"#9ca3af" }}>{opt.desc}</div>
        </div>
      ))}
    </div>
  );
}
