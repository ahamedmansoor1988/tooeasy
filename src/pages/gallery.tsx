import React, { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  editScreenshot,
  getLastActiveApp,
  listScreenshots,
  onScreenshotsUpdated,
  trashScreenshot,
  pasteFileToApp,
  copyImageFile,
  showPanel,
  openSystemSettings,
} from "../lib/tauri";
import type { ScreenshotItem } from "../lib/tauri";
import AnnotationCanvas from "../components/AnnotationCanvas";
import tooeasyWordmarkUrl from "../assets/logos/tooeasy-wordmark.svg";
import claudeLogoUrl from "../assets/logos/claude.svg";
import chatgptLogoUrl from "../assets/logos/chatgpt.svg";
import figmaLogoUrl from "../assets/logos/figma.svg";
import chromeLogoUrl from "../assets/logos/chrome.svg";

function Ri({ icon, gradient, size = 16, style }: { icon: string; gradient: string; size?: number; style?: React.CSSProperties }) {
  void gradient;
  return (
    <i className={icon} style={{
      fontSize: size,
      color: "var(--gallery-icon)",
      WebkitTextFillColor: "var(--gallery-icon)",
      lineHeight: 1,
      display: "inline-block",
      ...style,
    }} />
  );
}

type Filter = "all" | "today" | "week" | "month" | "favourites";
type View = "gallery" | "settings" | "profile";
type SortMode = "newest" | "oldest" | "source";

function isToday(d: string) {
  return d.startsWith(new Date().toLocaleDateString("en-US", { month:"short", day:"numeric", year:"numeric" }));
}
function isThisWeek(d: string) {
  const w = new Date(); w.setDate(w.getDate()-7);
  return new Date(d) >= w;
}
function isThisMonth(d: string) {
  const m = new Date(); m.setMonth(m.getMonth()-1);
  return new Date(d) >= m;
}


function sourceFromFilename(filename: string) {
  const base = filename.replace(/\.png$/i, "");
  const parts = base.split("_");
  const raw = parts.length >= 3 ? parts.slice(2).join(" ") : "Unknown";
  return titleCase(raw.replace(/\s+/g, " ").trim() || "Unknown");
}

function titleCase(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .map(word => word.length <= 3 && word === word.toUpperCase()
      ? word
      : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function smartTitle(item: ScreenshotItem) {
  const source = sourceFromFilename(item.filename);
  const timeParts = item.captured_at.split(", ");
  const time = timeParts[timeParts.length - 1] ?? "";
  if (source === "Unknown") return `Screenshot at ${time}`;
  return `${source} capture`;
}

function sourceBrand(source: string) {
  const s = source.toLowerCase();
  if (s.includes("chrome")) return { logo: chromeLogoUrl, icon:"ri-chrome-fill", gradient:"linear-gradient(135deg,#22c55e,#3b82f6)" };
  if (s.includes("figma")) return { logo: figmaLogoUrl, icon:"ri-figma-fill", gradient:"linear-gradient(135deg,#f24e1e,#a259ff)" };
  if (s.includes("claude")) return { logo: claudeLogoUrl, icon:"ri-sparkling-2-fill", gradient:"linear-gradient(135deg,#d97757,#f59e0b)" };
  if (s.includes("chatgpt") || s.includes("openai")) return { logo: chatgptLogoUrl, icon:"ri-openai-fill", gradient:"linear-gradient(135deg,#4b5563,#111827)" };
  if (s.includes("cursor") || s.includes("code")) return { icon:"ri-code-box-fill", gradient:"linear-gradient(135deg,#4b5563,#111827)" };
  if (s.includes("slack")) return { icon:"ri-slack-fill", gradient:"linear-gradient(135deg,#4b5563,#111827)" };
  return { icon:"ri-macbook-fill", gradient:"linear-gradient(135deg,#4b5563,#111827)" };
}

function sourceGroups(items: ScreenshotItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const source = sourceFromFilename(item.filename);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, count]) => ({ label, count, ...sourceBrand(label) }));
}

function sortItems(items: ScreenshotItem[], sort: SortMode) {
  const next = [...items];
  if (sort === "oldest") next.reverse();
  if (sort === "source") {
    next.sort((a, b) => sourceFromFilename(a.filename).localeCompare(sourceFromFilename(b.filename)));
  }
  return next;
}

function BrandMark({ item, size = 14 }: { item: { logo?: string; icon: string; gradient: string }; size?: number }) {
  if (item.logo) {
    return <img src={item.logo} alt="" draggable={false} style={{ width:size, height:size, objectFit:"contain", display:"block" }} />;
  }
  return <Ri icon={item.icon} gradient={item.gradient} size={size} />;
}

export default function GalleryPage() {
  const [view, setView]         = useState<View>("gallery");
  const [filter, setFilter]     = useState<Filter>("all");
  const [screenshots, setShots] = useState<ScreenshotItem[]>([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState("");
  const [sort, setSort]         = useState<SortMode>("newest");
  const [cols, setCols]         = useState(4);
  const [busyPath, setBusy]     = useState<string|null>(null);
  const [annotating, setAnnotating] = useState<ScreenshotItem|null>(null);
  const [preview, setPreview]   = useState<ScreenshotItem|null>(null);
  const [activeApp, setActiveApp] = useState({ bundle_id: "", name: "" });
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem("onboarded") === "1");
  const [favs, setFavs] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem("te_favs") ?? "[]"))
  );
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("te_display_name") ?? "MANS");
  const [avatarColor, setAvatarColor] = useState(() => localStorage.getItem("te_avatar_color") ?? "#64748b");

  function toggleFav(filepath: string) {
    setFavs(prev => {
      const n = new Set(prev);
      n.has(filepath) ? n.delete(filepath) : n.add(filepath);
      localStorage.setItem("te_favs", JSON.stringify([...n]));
      return n;
    });
  }

  const refreshingRef = useRef(false);
  function refresh() {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    listScreenshots()
      .then(setShots)
      .catch(console.error)
      .finally(() => { setLoading(false); refreshingRef.current = false; });
  }
  useEffect(() => {
    refresh();
    getLastActiveApp().then(setActiveApp).catch(() => {});
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
  async function handleCopy(s: ScreenshotItem) {
    setBusy(s.filepath); try { await copyImageFile(s.filepath); } catch {} finally { setBusy(null); }
  }
  async function handlePaste(s: ScreenshotItem, bundleId = activeApp.bundle_id) {
    if (!bundleId) return;
    setBusy(s.filepath); try { await pasteFileToApp(s.filepath, bundleId); } catch {} finally { setBusy(null); }
  }

  // Single pass for sidebar counts
  let todayCount = 0, weekCount = 0, favsCount = 0;
  for (const s of screenshots) {
    if (isToday(s.captured_at))    todayCount++;
    if (isThisWeek(s.captured_at)) weekCount++;
    if (favs.has(s.filepath))      favsCount++;
  }
  const monthCount = screenshots.length;

  const filtered = React.useMemo(() => {
    const lowerSearch = search.toLowerCase();
    return sortItems(screenshots.filter(s => {
      if (search) {
        const source = sourceFromFilename(s.filename);
        const haystack = `${s.filename} ${smartTitle(s)} ${source} ${s.captured_at}`.toLowerCase();
        if (!haystack.includes(lowerSearch)) return false;
      }
      if (filter === "today")       return isToday(s.captured_at);
      if (filter === "week")        return isThisWeek(s.captured_at);
      if (filter === "month")       return isThisMonth(s.captured_at);
      if (filter === "favourites")  return favs.has(s.filepath);
      return true;
    }), sort);
  }, [screenshots, search, filter, sort, favs]);

  const bySource = React.useMemo(() => sourceGroups(screenshots), [screenshots]);

  if (!onboarded) {
    return <Onboarding onDone={() => { localStorage.setItem("onboarded","1"); setOnboarded(true); }} />;
  }

  return (
    <div className="gallery-floating-root">
      <div className="gallery-window-material">
        <div className="gallery-window-content">

      {/* Titlebar */}
      <div data-tauri-drag-region className="titlebar-glass gallery-floating-titlebar"
        onMouseDown={e => {
          const target = e.target as HTMLElement;
          if (!target.closest("button,input,select")) {
            void getCurrentWindow().startDragging().catch(() => {});
          }
        }}
        style={{ height:56, display:"flex", alignItems:"center", padding:"0 20px", gap:12, flexShrink:0,
          WebkitAppRegion:"drag" } as React.CSSProperties}>
        <WindowControls />
        <div
          aria-label="TooEasy"
          role="img"
          style={{
            height:22,
            width:96,
            display:"block",
            background:"var(--gallery-text-1)",
            mask:`url(${tooeasyWordmarkUrl}) left center / contain no-repeat`,
            WebkitMask:`url(${tooeasyWordmarkUrl}) left center / contain no-repeat`,
          }}
        />
        <div style={{ flex:1 }} data-tauri-drag-region />
        <div style={{ display:"flex", alignItems:"center", gap:6, WebkitAppRegion:"no-drag" } as React.CSSProperties}>
          <button style={tbIconBtn} title="Notifications">
            <i className="ri-notification-3-line" style={{ fontSize:17, color:"var(--gallery-control-text)", WebkitTextFillColor:"var(--gallery-control-text)", lineHeight:1 }} />
          </button>
          <button style={tbIconBtn} title="More options">
            <i className="ri-more-fill" style={{ fontSize:17, color:"var(--gallery-control-text)", WebkitTextFillColor:"var(--gallery-control-text)", lineHeight:1 }} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="gallery-shell gallery-floating-shell" style={{ flex:1, display:"flex", overflow:"hidden" }}>

        {/* Left sidebar */}
        <div className="gallery-rail" style={{
          width:206, flexShrink:0, padding:"12px 10px",
          borderRight:"1px solid rgba(255,255,255,0.28)",
          display:"flex", flexDirection:"column",
        }}>
          {/* Search */}
          <div style={{ marginBottom:10 }}>
            <div style={{ position:"relative" }}>
              <Ri icon="ri-search-line" gradient="linear-gradient(135deg,#6b7280,#111827)" size={13}
                style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)" }} />
              <input value={search} onChange={e => { setSearch(e.target.value); setView("gallery"); }}
                placeholder="Search…"
                style={{ width:"100%", height:32, paddingLeft:30, paddingRight:10,
                  background:"rgba(255,255,255,0.30)", border:"1px solid rgba(255,255,255,0.44)",
                  borderRadius:8, fontSize:12.5, color:"var(--gallery-text-1)", outline:"none",
                  boxShadow:"inset 0 1px 0 rgba(255,255,255,0.58)",
                  boxSizing:"border-box" as const }} />
            </div>
          </div>

          {/* Nav items */}
          <div style={{ flex:1, overflowY:"auto" }}>
            {[
              { id:"all",        label:"All Screenshots", count:monthCount,  icon:"ri-image-fill",       gradient:"linear-gradient(135deg,#4b5563,#111827)" },
              { id:"today",      label:"Today",           count:todayCount,  icon:"ri-sun-fill",         gradient:"linear-gradient(135deg,#f59e0b,#f97316)" },
              { id:"week",       label:"This Week",       count:weekCount,   icon:"ri-calendar-2-fill",  gradient:"linear-gradient(135deg,#4b5563,#111827)" },
              { id:"month",      label:"This Month",      count:monthCount,  icon:"ri-calendar-fill",    gradient:"linear-gradient(135deg,#4b5563,#111827)" },
              { id:"favourites", label:"Favourites",      count:favsCount,   icon:"ri-star-fill",        gradient:"linear-gradient(135deg,#f59e0b,#eab308)" },
            ].map(item => (
              <button key={item.id}
                onClick={() => { setFilter(item.id as Filter); setView("gallery"); }}
                className={`sidebar-item ${view==="gallery" && filter===item.id ? "active" : ""}`}
                style={{ width:"100%", textAlign:"left", border:"none", display:"flex", alignItems:"center", gap:8, padding:"7px 10px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", marginBottom:2 }}>
                <Ri icon={item.icon} gradient={item.gradient} size={15} />
                <span style={{ flex:1, fontSize:13, fontWeight:500 }}>{item.label}</span>
                <span style={{ fontSize:12, color:"var(--gallery-text-3)" }}>{item.count}</span>
              </button>
            ))}

            <div style={{ height:1, background:"rgba(255,255,255,0.34)", margin:"10px 0" }} />

            <div style={{ padding:"2px 6px 6px", fontSize:11, fontWeight:500, color:"var(--gallery-text-3)", textTransform:"uppercase", letterSpacing:"0.06em" }}>
              Sources
            </div>
            {bySource.length === 0 ? (
              <div style={{ fontSize:12, color:"var(--gallery-text-3)", padding:"4px 10px" }}>Appear after captures.</div>
            ) : bySource.map(item => (
              <button key={item.label}
                onClick={() => { setSearch(item.label); setFilter("all"); setView("gallery"); }}
                className="sidebar-item"
                style={{ width:"100%", textAlign:"left", border:"none", display:"flex", alignItems:"center", gap:8, padding:"7px 10px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", marginBottom:2 }}>
                <BrandMark item={item} size={15} />
                <span style={{ flex:1, fontSize:13, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{item.label}</span>
                <span style={{ fontSize:12, color:"var(--gallery-text-3)" }}>{item.count}</span>
              </button>
            ))}
          </div>

          {/* Bottom: user + settings */}
          <div style={{ borderTop:"1px solid rgba(255,255,255,0.28)", paddingTop:10, marginTop:8 }}>
            <button
              onClick={() => setView("profile")}
              className={`sidebar-item ${view === "profile" ? "active" : ""}`}
              style={{ width:"100%", border:"none", display:"flex", alignItems:"center", gap:9, padding:"6px 10px", borderRadius:8, cursor:"pointer", fontFamily:"inherit", marginBottom:2, textAlign:"left" }}>
              <div style={{
                width:28, height:28, borderRadius:"50%", flexShrink:0,
                background: avatarColor,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:11, fontWeight:700, color:"white",
              }}>{displayName.charAt(0).toUpperCase()}</div>
              <span style={{ fontSize:13, fontWeight:600, color:"var(--gallery-text-1)" }}>{displayName}</span>
            </button>
            <button
              onClick={() => setView("settings")}
              className={`sidebar-item ${view==="settings" ? "active" : ""}`}
              style={{ width:"100%", textAlign:"left", border:"none", display:"flex", alignItems:"center", gap:8, padding:"7px 10px", borderRadius:8, cursor:"pointer", fontFamily:"inherit" }}>
              <Ri icon="ri-settings-3-fill" gradient="linear-gradient(135deg,#4b5563,#111827)" size={15} />
              <span style={{ fontSize:13, fontWeight:500 }}>Settings</span>
            </button>
          </div>
        </div>

        {/* Main area */}
        {view === "settings" ? (
          <div style={{ flex:1, overflowY:"auto" }}>
            <SettingsTab />
          </div>
        ) : view === "profile" ? (
          <div style={{ flex:1, overflowY:"auto" }}>
            <ProfilePanel
              displayName={displayName}
              avatarColor={avatarColor}
              totalCount={screenshots.length}
              todayCount={todayCount}
              favsCount={favsCount}
              onNameChange={name => { setDisplayName(name); localStorage.setItem("te_display_name", name); }}
              onColorChange={color => { setAvatarColor(color); localStorage.setItem("te_avatar_color", color); }}
            />
          </div>
        ) : (
          <div className="gallery-main-scroll" style={{ flex:1, overflowY:"auto", padding:"24px 24px" }}>
            {/* Header row */}
            <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between", marginBottom:20 }}>
              <h1 style={{ fontSize:22, fontWeight:600, color:"var(--gallery-text-1)", margin:0 }}>
                {filter === "all" ? "All Screenshots" : filter === "today" ? "Today" : filter === "week" ? "This Week" : filter === "month" ? "This Month" : "Favourites"}
              </h1>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                {/* Column picker — 2 circles vertical / 4 circles 2×2 */}
                <div style={{ display:"flex", alignItems:"center", height:30,
                  background:"rgba(255,255,255,0.50)", border:"1px solid rgba(255,255,255,0.60)",
                  borderRadius:8, overflow:"hidden",
                  boxShadow:"inset 0 1px 0 rgba(255,255,255,0.70)" }}>
                  {([2, 4] as const).map((n, i) => {
                    const active = cols === n;
                    const fill = active ? "var(--gallery-view-active)" : "var(--gallery-view-inactive)";
                    return (
                      <button key={n} onClick={() => setCols(n)} style={{
                        width:32, height:30, border:"none", cursor:"pointer", padding:0,
                        display:"flex", alignItems:"center", justifyContent:"center",
                        background: active ? "rgba(255,255,255,0.34)" : "transparent",
                        borderRight: i === 0 ? "1px solid rgba(255,255,255,0.42)" : "none",
                        transition:"background 120ms",
                      }}>
                        {n === 2 ? (
                          /* 2x2 dots */
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            {[3, 11].flatMap(y => [3, 11].map(x => (
                              <circle key={`${x}-${y}`} cx={x} cy={y} r="2.7" fill={fill} />
                            )))}
                          </svg>
                        ) : (
                          /* 4x4 dots */
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            {[2.5, 6.2, 9.8, 13.5].flatMap(y => [2.5, 6.2, 9.8, 13.5].map(x => (
                              <circle key={`${x}-${y}`} cx={x} cy={y} r="1.45" fill={fill} />
                            )))}
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
                <label style={{ display:"flex", alignItems:"center", gap:5, height:30, padding:"0 12px",
                  background:"rgba(255,255,255,0.50)", border:"1px solid rgba(255,255,255,0.60)",
                  borderRadius:8, cursor:"pointer",
                  boxShadow:"inset 0 1px 0 rgba(255,255,255,0.70)" }}>
                  <span style={{ fontSize:12.5, color:"var(--gallery-text-2)", fontWeight:500 }}>Sort by</span>
                  <select value={sort} onChange={e => setSort(e.target.value as SortMode)}
                    style={{ border:"none", outline:"none", background:"transparent", fontFamily:"inherit", fontSize:12.5, color:"var(--gallery-text-1)", cursor:"pointer" }}>
                    <option value="newest">Newest</option>
                    <option value="oldest">Oldest</option>
                    <option value="source">Source</option>
                  </select>
                </label>
              </div>
            </div>

            {loading ? (
              <div style={{ textAlign:"center", padding:64, color:"var(--gallery-text-3)" }}>Loading…</div>
            ) : filtered.length === 0 ? (
              <EmptyState message={search ? "No results." : filter === "favourites" ? "Star a screenshot to add it here." : undefined} />
            ) : (
              <div style={{ display:"grid", gridTemplateColumns:`repeat(${cols}, 1fr)`, gap:20 }}>
                {filtered.map(s => (
                  <ScreenshotCard key={s.filepath} screenshot={s}
                    busy={busyPath===s.filepath}
                    isFav={favs.has(s.filepath)}
                    onToggleFav={() => toggleFav(s.filepath)}
                    onCopy={() => handleCopy(s)}
                    onPaste={() => handlePaste(s)}
                    onTrash={() => handleTrash(s)}
                    onPreview={() => setPreview(s)}
                    onAnnotate={() => setAnnotating(s)}
                    onMoveToPanel={async () => { await copyImageFile(s.filepath).catch(() => {}); await showPanel().catch(() => {}); }} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
        </div>
      </div>

      {preview && (
        <ScreenshotPreview
          screenshot={preview}
          onClose={() => setPreview(null)}
          onMoveToPanel={async () => {
            await copyImageFile(preview.filepath).catch(() => {});
            await showPanel().catch(() => {});
            setPreview(null);
          }}
          onAnnotate={() => { setAnnotating(preview); setPreview(null); }}
          onOpen={() => handleEdit(preview.filepath)}
          onTrash={() => { handleTrash(preview); setPreview(null); }}
        />
      )}
      {annotating && <AnnotationCanvas screenshot={annotating} onClose={() => setAnnotating(null)} />}
    </div>
  );
}

// ── Screenshot card ──────────────────────────────────────────────────────────
function ScreenshotCard({ screenshot, busy, isFav, onToggleFav, onCopy, onPaste, onTrash, onPreview, onAnnotate, onMoveToPanel }: {
  screenshot: ScreenshotItem; busy: boolean; isFav: boolean;
  onToggleFav: ()=>void; onCopy: ()=>void; onPaste: ()=>void; onTrash: ()=>void; onPreview: ()=>void; onAnnotate: ()=>void; onMoveToPanel: ()=>void;
}) {
  void busy; void onCopy; void onPaste; void onAnnotate;
  const [hovered, setHovered] = useState(false);
  const source = sourceFromFilename(screenshot.filename);
  return (
    <article
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onPreview}
      style={{ cursor:"pointer", userSelect:"none" }}>

      {/* Square image tile */}
      <div style={{
        aspectRatio:"1/1", borderRadius:20, overflow:"hidden",
        background:"#e8eaf0", position:"relative",
        transform: hovered ? "scale(1.03)" : "scale(1)",
        boxShadow: hovered
          ? "0 16px 40px rgba(17,24,39,0.18)"
          : "0 4px 14px rgba(17,24,39,0.10)",
        transition:"transform 180ms cubic-bezier(0.34,1.2,0.64,1), box-shadow 180ms ease",
      }}>
        <img
          src={convertFileSrc(screenshot.filepath)}
          alt={screenshot.filename}
          loading="lazy" decoding="async"
          style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}
        />

        {/* Star */}
        {(hovered || isFav) && (
          <button
            onClick={e => { e.stopPropagation(); onToggleFav(); }}
            style={{
              position:"absolute", top:8, right:8,
              width:28, height:28, borderRadius:8, border:"none",
              background: isFav ? "rgba(234,179,8,0.95)" : "rgba(0,0,0,0.32)",
              backdropFilter:"blur(4px)",
              display:"flex", alignItems:"center", justifyContent:"center",
              cursor:"pointer", padding:0, transition:"background 120ms",
            }}>
            <i className={isFav ? "ri-star-fill" : "ri-star-line"}
              style={{ fontSize:14, color:"white", WebkitTextFillColor:"white", lineHeight:1 }} />
          </button>
        )}

        {/* Hover action bar at bottom */}
        {hovered && (
          <div style={{
            position:"absolute", bottom:0, left:0, right:0,
            background:"linear-gradient(to top, rgba(0,0,0,0.72) 0%, transparent 100%)",
            padding:"20px 8px 8px",
            display:"flex", gap:5, alignItems:"flex-end",
          }}>
            <button onClick={e => { e.stopPropagation(); onMoveToPanel(); }} style={overlayBtn("rgba(255,255,255,0.18)","#fff")}>Move to panel</button>
            <div style={{ flex:1 }} />
            <button onClick={e => { e.stopPropagation(); onTrash(); }} style={overlayIconBtn("rgba(239,68,68,0.88)")}>
              <i className="ri-delete-bin-fill" style={{ fontSize:12, color:"#fff", WebkitTextFillColor:"#fff", lineHeight:1 }} />
            </button>
          </div>
        )}
      </div>

      {/* Info below card */}
      <div style={{ padding:"9px 4px 0", textAlign:"center" }}>
        <div style={{ fontSize:13, fontWeight:500, color:"var(--gallery-text-1)",
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {source}
        </div>
        <div style={{ fontSize:12, color:"var(--gallery-text-3)", marginTop:2 }}>
          {screenshot.captured_at.split(",").slice(-1)[0].trim()}
        </div>
      </div>
    </article>
  );
}

function overlayBtn(bg: string, color: string): React.CSSProperties {
  return {
    padding:"5px 10px", borderRadius:999, border:"1px solid rgba(255,255,255,0.42)",
    background:bg, color, fontSize:11, fontWeight:500, cursor:"pointer",
    boxShadow:"inset 0 1px 0 rgba(255,255,255,0.28)",
  };
}

function overlayIconBtn(bg: string): React.CSSProperties {
  return {
    width:26, height:24, borderRadius:999, border:"none",
    background:bg, display:"flex", alignItems:"center", justifyContent:"center",
    cursor:"pointer",
  };
}

const tbIconBtn: React.CSSProperties = {
  width:32, height:32, borderRadius:8, border:"none",
  background:"rgba(255,255,255,0.42)",
  display:"flex", alignItems:"center", justifyContent:"center",
  cursor:"pointer", padding:0,
  boxShadow:"inset 0 1px 0 rgba(255,255,255,0.70)",
};

function WindowControls() {
  const win = getCurrentWindow();
  const [hovered, setHovered] = useState(false);
  const controls = [
    { label:"Close",    color:"#ff5f57", icon:"✕", action: () => win.close() },
    { label:"Minimize", color:"#ffbd2e", icon:"−", action: () => win.minimize() },
    { label:"Maximize", color:"#28c840", icon:"+", action: () => win.toggleMaximize() },
  ];
  return (
    <div
      style={{ display:"flex", alignItems:"center", gap:8, marginRight:10, WebkitAppRegion:"no-drag" } as React.CSSProperties}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={e => e.stopPropagation()}>
      {controls.map(control => (
        <button
          key={control.label}
          title={control.label}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => { e.stopPropagation(); void control.action().catch(() => {}); }}
          style={{
            width:13, height:13, borderRadius:"50%",
            border:"1px solid rgba(0,0,0,0.13)",
            background:control.color,
            cursor:"pointer", padding:0,
            outline:"none",
            display:"flex", alignItems:"center", justifyContent:"center",
            boxShadow:"inset 0 1px 0 rgba(255,255,255,0.45), 0 1px 2px rgba(0,0,0,0.12)",
            WebkitAppRegion:"no-drag",
          } as React.CSSProperties}>
          {hovered && (
            <span style={{ fontSize:8, fontWeight:900, lineHeight:1, color:"rgba(0,0,0,0.55)", pointerEvents:"none", userSelect:"none" }}>
              {control.icon}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function ScreenshotPreview({ screenshot, onClose, onMoveToPanel, onAnnotate, onOpen, onTrash }: {
  screenshot: ScreenshotItem;
  onClose: ()=>void;
  onMoveToPanel: ()=>void;
  onAnnotate: ()=>void;
  onOpen: ()=>void;
  onTrash: ()=>void;
}) {
  const source = sourceFromFilename(screenshot.filename);
  const brand = sourceBrand(source);

  // AI state
  const [blurBoxes, setBlurBoxes]     = useState<{x:number;y:number;w:number;h:number}[]>([]);
  const [blurActive, setBlurActive]   = useState(false);
  const [blurLoading, setBlurLoading] = useState(false);
  const [pdfLoading, setPdfLoading]   = useState(false);
  const [pdfMsg, setPdfMsg]           = useState<string|null>(null);
  const [aiError, setAiError]         = useState<string|null>(null);
  const [naturalSize, setNaturalSize] = useState({ w: 1, h: 1 });

  async function callVision(prompt: string): Promise<string> {
    const provider = (localStorage.getItem("te_ai_provider") ?? "anthropic") as AiProvider;
    const keyMap: Record<AiProvider, string|null> = {
      anthropic: localStorage.getItem("te_ai_key_anthropic"),
      openai:    localStorage.getItem("te_ai_key_openai"),
      groq:      localStorage.getItem("te_ai_key_groq"),
    };
    const key = keyMap[provider];
    if (!key) throw new Error(`No API key for "${provider}". Go to Settings → AI & API and enter your key.`);

    // data_url is empty in list results — fetch the file on-demand via asset:// URL
    let dataUrl = screenshot.data_url;
    if (!dataUrl) {
      const assetUrl = convertFileSrc(screenshot.filepath);
      const blob = await fetch(assetUrl).then(r => r.blob());
      dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const mime   = dataUrl.match(/^data:(image\/\w+);/)?.[1] ?? "image/png";

    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 2048,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
            { type: "text", text: prompt },
          ]}],
        }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      const d = await res.json();
      return d.content[0].text as string;
    } else if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 2048,
          messages: [{ role: "user", content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: prompt },
          ]}],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
      const d = await res.json();
      return d.choices[0].message.content as string;
    } else {
      // Groq — OpenAI-compatible, vision via llama-4-scout
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          max_tokens: 2048,
          messages: [{ role: "user", content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: prompt },
          ]}],
        }),
      });
      if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
      const d = await res.json();
      return d.choices[0].message.content as string;
    }
  }

  async function handleSmartBlur() {
    if (blurActive) { setBlurActive(false); setBlurBoxes([]); return; }
    setBlurLoading(true); setAiError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");

      // Step 1 — native macOS Vision OCR (accurate, no worker issues)
      type OcrLine = { text: string; y: number; h: number };
      const lines: OcrLine[] = await invoke("ocr_image", { filepath: screenshot.filepath });

      const fullText = lines.map(l => l.text).join("\n");

      // Step 2 — regex on OCR text to find sensitive values
      const PATTERNS: RegExp[] = [
        /(?:api[_\- ]?key|api[_\- ]?secret|password|passwd|pwd|secret|token|auth(?:key)?|credential|access[_\- ]?key|private[_\- ]?key|db[_\- ]?pass(?:word)?|database[_\- ]?(?:url|password))\s*[-:=\s]\s*(\S{4,})/gi,
        /\b(sk-[a-zA-Z0-9_-]{10,}|gsk_[a-zA-Z0-9_-]{10,}|sk-ant-[a-zA-Z0-9_-]{10,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{20,}|xox[bpa]-[a-zA-Z0-9-]{10,})/g,
        /[Bb]earer\s+([a-zA-Z0-9._~+/=-]{10,})/g,
        /\b(\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g,
        /\b(\d{3}-\d{2}-\d{4})\b/g,
      ];

      const sensitiveValues: string[] = [];
      for (const pat of PATTERNS) {
        for (const m of fullText.matchAll(pat)) {
          const val = (m[1] ?? m[0]).trim();
          if (val.length >= 4) sensitiveValues.push(val);
        }
      }

      if (sensitiveValues.length === 0) {
        setBlurBoxes([]); setBlurActive(true); return;
      }

      // Step 4 — match found values to OCR line positions → blur those rows
      const normalize = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
      const matched = lines.filter(line => {
        const lt = normalize(line.text);
        if (lt.length < 3) return false;
        return sensitiveValues.some(s => {
          const sn = normalize(s);
          return lt.includes(sn.substring(0, Math.min(8, sn.length))) || sn.includes(lt.substring(0, Math.min(8, lt.length)));
        });
      });

      const boxes = matched.map(line => ({
        x: 0,
        y: Math.max(0, line.y - 0.005),
        w: 1,
        h: Math.min(1, line.h + 0.01),
      }));

      setBlurBoxes(boxes);
      setBlurActive(true);
    } catch(e) {
      setAiError(e instanceof Error ? e.message : "AI error");
    } finally {
      setBlurLoading(false);
    }
  }

  async function handleExtractPDF() {
    setPdfLoading(true); setAiError(null); setPdfMsg(null);
    try {
      const text = await callVision(
        `Extract ALL visible text from this screenshot. Preserve structure and layout using plain text. Include all text: UI labels, code, content, numbers, everything visible. Return only the extracted text.`
      );
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF();
      doc.setFontSize(11);
      const lines = doc.splitTextToSize(text, 180);
      doc.text(lines, 15, 20);
      const pdfName = `${screenshot.filename.replace(/\.png$/i, "")}_text.pdf`;
      doc.save(pdfName);
      setPdfMsg(`Saved to ~/Downloads/${pdfName}`);
      setTimeout(() => setPdfMsg(null), 5000);
    } catch(e) {
      setAiError(e instanceof Error ? e.message : "AI error");
    } finally {
      setPdfLoading(false);
    }
  }

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:50,
      background:"transparent",
      display:"flex", alignItems:"center", justifyContent:"center",
      padding:18,
      backdropFilter:"none",
    }}>
      <div style={{
        width:"min(1040px, calc(100vw - 36px))", height:"min(680px, calc(100vh - 36px))",
        background:"rgba(255,255,255,0.44)", borderRadius:22, overflow:"hidden",
        display:"grid", gridTemplateColumns:"1fr 300px",
        border:"1px solid rgba(255,255,255,0.42)",
        boxShadow:"0 20px 56px rgba(15,23,42,0.14), 0 4px 14px rgba(15,23,42,0.07), inset 0 1px 0 rgba(255,255,255,0.58)",
        backdropFilter:"blur(42px) saturate(0.92) brightness(1.08)",
      }}>
        {/* Image panel */}
        <div style={{ background:"rgba(255,255,255,0.24)", display:"flex", alignItems:"center", justifyContent:"center", padding:18, overflow:"hidden", minHeight:0, position:"relative" }}>
          {/* Wrapper sized to exact image aspect ratio — blur overlays use % within it */}
          <div style={{ position:"relative", maxWidth:"100%", maxHeight:"100%", aspectRatio:`${naturalSize.w} / ${naturalSize.h}`, borderRadius:12, overflow:"hidden", boxShadow:"0 12px 34px rgba(31,38,62,0.16)" }}>
            <img
              src={convertFileSrc(screenshot.filepath)}
              alt={smartTitle(screenshot)}
              decoding="async"
              onLoad={e => {
                const img = e.currentTarget;
                setNaturalSize({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
              }}
              style={{ width:"100%", height:"100%", objectFit:"fill", display:"block" }} />

            {/* Blur overlays — % coords map 1:1 to image pixels */}
            {blurActive && blurBoxes.map((box, i) => (
              <div key={i} style={{
                position:"absolute",
                left:   `${box.x * 100}%`,
                top:    `${box.y * 100}%`,
                width:  `${box.w * 100}%`,
                height: `${box.h * 100}%`,
                backdropFilter:"blur(20px) brightness(0.88)",
                background:"rgba(0,0,0,0.12)",
                borderRadius:3,
                pointerEvents:"none",
              }} />
            ))}
          </div>

          {/* Blur badge */}
          {blurActive && (
            <div style={{ position:"absolute", top:24, left:24, display:"flex", alignItems:"center", gap:5, padding:"4px 10px", borderRadius:999, background:"rgba(239,68,68,0.18)", border:"1px solid rgba(239,68,68,0.36)", fontSize:11, fontWeight:600, color:"#ef4444" }}>
              <i className="ri-shield-fill" style={{ fontSize:11, color:"#ef4444", WebkitTextFillColor:"#ef4444" }} />
              {blurBoxes.length === 0 ? "Nothing sensitive found" : `${blurBoxes.length} area${blurBoxes.length > 1 ? "s" : ""} blurred`}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <aside style={{ padding:20, display:"flex", flexDirection:"column", borderLeft:"1px solid rgba(255,255,255,0.38)", overflowY:"auto", background:"rgba(255,255,255,0.12)" }}>
          {/* Header */}
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <div className="gallery-icon-tile" style={{ width:30, height:30, borderRadius:9, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <BrandMark item={brand} size={16} />
              </div>
              <span style={{ fontSize:12, fontWeight:500, color:"var(--gallery-text-2)" }}>{source}</span>
            </div>
            <button onClick={onClose} className="gallery-icon-tile" style={{ width:30, height:30, borderRadius:"50%", border:"none", cursor:"pointer" }}>
              <i className="ri-close-fill" style={{ fontSize:16, color:"var(--gallery-icon)", WebkitTextFillColor:"var(--gallery-icon)" }} />
            </button>
          </div>

          <h2 style={{ fontSize:20, lineHeight:1.2, fontWeight:500, color:"var(--gallery-text-1)", margin:"0 0 8px" }}>{smartTitle(screenshot)}</h2>
          <p style={{ fontSize:13, lineHeight:1.55, color:"var(--gallery-text-2)", margin:"0 0 18px" }}>
            Captured from {source} on {screenshot.captured_at}.
          </p>

          {/* Standard actions */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
            <button onClick={onMoveToPanel} style={previewActionStyle(true)}>
              <Ri icon="ri-layout-grid-fill" gradient="linear-gradient(135deg,#4b5563,#111827)" size={15} style={{ color:"#1c1c1e", WebkitTextFillColor:"#1c1c1e" }} />
              Move to panel
            </button>
            <button onClick={onAnnotate} style={previewActionStyle(false)}>
              <Ri icon="ri-pencil-ruler-2-fill" gradient="linear-gradient(135deg,#4b5563,#111827)" size={15} />
              Annotate
            </button>
          </div>

          {/* AI actions */}
          <div style={{ borderTop:"1px solid rgba(255,255,255,0.20)", paddingTop:12, marginBottom:14 }}>
            <div style={{ fontSize:10, fontWeight:600, color:"var(--gallery-text-3)", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8 }}>AI</div>
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              <button
                onClick={handleSmartBlur}
                disabled={blurLoading}
                style={{
                  ...previewActionStyle(blurActive),
                  opacity: blurLoading ? 0.7 : 1,
                  background: blurActive ? "rgba(239,68,68,0.14)" : undefined,
                  borderColor: blurActive ? "rgba(239,68,68,0.40)" : undefined,
                  color: blurActive ? "#ef4444" : undefined,
                  justifyContent:"flex-start", gap:7, paddingLeft:12,
                }}>
                {blurLoading
                  ? <><i className="ri-loader-4-line" style={{ fontSize:14, animation:"spin 1s linear infinite", lineHeight:1 }} /> Scanning…</>
                  : blurActive
                    ? <><i className="ri-eye-off-fill" style={{ fontSize:14, color:"#ef4444", WebkitTextFillColor:"#ef4444", lineHeight:1 }} /> Remove blur</>
                    : <><i className="ri-shield-fill" style={{ fontSize:14, lineHeight:1 }} /> Smart Blur</>
                }
              </button>

              <button
                onClick={handleExtractPDF}
                disabled={pdfLoading}
                style={{ ...previewActionStyle(false), opacity: pdfLoading ? 0.7 : 1, justifyContent:"flex-start", gap:7, paddingLeft:12 }}>
                {pdfLoading
                  ? <><i className="ri-loader-4-line" style={{ fontSize:14, animation:"spin 1s linear infinite", lineHeight:1 }} /> Extracting…</>
                  : <><i className="ri-file-text-fill" style={{ fontSize:14, lineHeight:1 }} /> Extract to PDF</>
                }
              </button>
            </div>

            {aiError && (
              <p style={{ fontSize:11, color:"#ef4444", marginTop:8, lineHeight:1.4 }}>{aiError}</p>
            )}
          </div>

          {/* PDF saved toast */}
          {pdfMsg && (
            <div style={{
              margin:"0 0 14px",
              padding:"10px 14px",
              borderRadius:12,
              background:"rgba(255,255,255,0.18)",
              border:"1px solid rgba(255,255,255,0.30)",
              display:"flex", alignItems:"flex-start", gap:8,
              boxShadow:"inset 0 1px 0 rgba(255,255,255,0.38)",
            }}>
              <i className="ri-download-fill adaptive-glass-text" style={{ fontSize:14, flexShrink:0, marginTop:1 }} />
              <div>
                <div className="adaptive-glass-text" style={{ fontSize:11, fontWeight:600, marginBottom:2 }}>PDF saved</div>
                <div className="adaptive-glass-text-muted" style={{ fontSize:10, wordBreak:"break-all", lineHeight:1.4 }}>{pdfMsg}</div>
              </div>
            </div>
          )}

          {/* Meta */}
          <div style={{ borderTop:"1px solid rgba(255,255,255,0.28)", paddingTop:14, display:"grid", gap:9, fontSize:12 }}>
            <MetaRow label="File" value={screenshot.filename} />
            <MetaRow label="Source" value={source} />
            <MetaRow label="Captured" value={screenshot.captured_at} />
          </div>

          <div style={{ flex:1 }} />
          <div style={{ display:"flex", gap:8, marginTop:14 }}>
            <button onClick={onOpen} style={{ ...footerActionStyle(), flex:1 }}>Open file</button>
            <button onClick={onTrash} title="Delete" style={deleteIconButtonStyle()}>
              <i className="ri-delete-bin-fill" style={{ fontSize:15, color:"#ef4444", WebkitTextFillColor:"#ef4444", lineHeight:1 }} />
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display:"grid", gridTemplateColumns:"70px 1fr", gap:8 }}>
      <span style={{ color:"var(--gallery-text-3)" }}>{label}</span>
      <span style={{ color:"var(--gallery-text-1)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{value}</span>
    </div>
  );
}

function previewActionStyle(primary: boolean): React.CSSProperties {
  return {
    minHeight:44,
    borderRadius:999,
    border: primary ? "1px solid rgba(255,255,255,0.74)" : "1px solid rgba(255,255,255,0.56)",
    background: primary ? "#ffffff" : "rgba(255,255,255,0.34)",
    color: primary ? "#1c1c1e" : "var(--gallery-text-1)",
    fontFamily:"inherit",
    fontSize:12,
    fontWeight:500,
    cursor:"pointer",
    display:"flex",
    alignItems:"center",
    justifyContent:"center",
    gap:6,
    padding:"0 10px",
    boxShadow: primary
      ? "0 10px 24px rgba(31,38,62,0.12), inset 0 1px 0 rgba(255,255,255,0.80)"
      : "inset 0 1px 0 rgba(255,255,255,0.58)",
  };
}

function footerActionStyle(): React.CSSProperties {
  return {
    height:36,
    borderRadius:999,
    border:"1px solid rgba(255,255,255,0.56)",
    background:"rgba(255,255,255,0.34)",
    color:"var(--gallery-text-1)",
    fontFamily:"inherit",
    fontSize:12,
    fontWeight:500,
    cursor:"pointer",
    boxShadow:"inset 0 1px 0 rgba(255,255,255,0.58)",
  };
}

function deleteIconButtonStyle(): React.CSSProperties {
  return {
    width:36,
    height:36,
    borderRadius:999,
    border:"1px solid rgba(239,68,68,0.38)",
    background:"rgba(239,68,68,0.12)",
    fontFamily:"inherit",
    cursor:"pointer",
    display:"flex",
    alignItems:"center",
    justifyContent:"center",
    boxShadow:"inset 0 1px 0 rgba(255,255,255,0.42)",
  };
}

// ── Profile ──────────────────────────────────────────────────────────────────
const AVATAR_COLORS = [
  "#ffffff", "#e5e7eb", "#94a3b8", "#f97316",
  "#eab308", "#10b981", "#0ea5e9", "#64748b",
];

function ProfilePanel({ displayName, avatarColor, totalCount, todayCount, favsCount, onNameChange, onColorChange }: {
  displayName: string; avatarColor: string;
  totalCount: number; todayCount: number; favsCount: number;
  onNameChange: (n: string) => void; onColorChange: (c: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const [isPro, setIsPro] = useState(false);
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  useEffect(() => {
    import("../lib/tauri").then(m => m.getIsPro()).then(setIsPro).catch(() => {});
  }, []);

  async function handleActivate() {
    const key = licenseKey.trim();
    if (!key) { setLicenseError("Enter your license key."); return; }
    setActivating(true); setLicenseError(null);
    try {
      const { activateLicense } = await import("../lib/tauri");
      await activateLicense(key);
      setIsPro(true); setLicenseKey("");
    } catch (e) {
      setLicenseError(e instanceof Error ? e.message : String(e));
    } finally { setActivating(false); }
  }

  async function handleDeactivate() {
    setDeactivating(true);
    try {
      const { deactivateLicense } = await import("../lib/tauri");
      await deactivateLicense();
      setIsPro(false);
    } catch {} finally { setDeactivating(false); }
  }

  function commitName() {
    const trimmed = draft.trim();
    if (trimmed) onNameChange(trimmed);
    setEditing(false);
  }

  return (
    <div style={{ padding:"28px 28px", maxWidth:520, margin:"0 auto" }}>
      <h1 style={{ fontSize:20, fontWeight:600, color:"#1c1c1e", marginBottom:4 }}>Profile</h1>
      <p style={{ fontSize:13, color:"#9ca3af", marginBottom:24 }}>Your identity, plan, and usage.</p>

      {/* Identity */}
      <SectionLabel>Identity</SectionLabel>
      <div className="settings-card" style={{ padding:"20px 20px", marginBottom:16 }}>
        {/* Avatar */}
        <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:20 }}>
          <div style={{
            width:64, height:64, borderRadius:"50%", background: avatarColor,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:26, fontWeight:700, color:"white", flexShrink:0,
            boxShadow:"0 4px 14px rgba(0,0,0,0.12)",
          }}>{displayName.charAt(0).toUpperCase()}</div>
          <div>
            <div style={{ fontSize:13, fontWeight:500, color:"#1c1c1e", marginBottom:8 }}>Avatar colour</div>
            <div style={{ display:"flex", gap:7 }}>
              {AVATAR_COLORS.map(c => (
                <button key={c} onClick={() => onColorChange(c)} style={{
                  width:22, height:22, borderRadius:"50%", background:c, border:"none",
                  cursor:"pointer", padding:0, flexShrink:0,
                  outline: avatarColor === c ? `3px solid ${c}` : "2px solid transparent",
                  outlineOffset:2,
                  boxShadow: avatarColor === c ? `0 0 0 1px white, 0 0 0 3px ${c}` : "none",
                }} />
              ))}
            </div>
          </div>
        </div>

        {/* Display name */}
        <div>
          <div style={{ fontSize:13, fontWeight:500, color:"#1c1c1e", marginBottom:6 }}>Display name</div>
          {editing ? (
            <div style={{ display:"flex", gap:8 }}>
              <input
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") commitName(); if (e.key === "Escape") setEditing(false); }}
                autoFocus
                style={{
                  flex:1, height:36, borderRadius:8, border:"1px solid rgba(255,255,255,0.54)",
                  padding:"0 12px", fontSize:13, fontFamily:"inherit", outline:"none",
                  background:"rgba(255,255,255,0.8)", color:"#1c1c1e",
                }}
              />
              <button onClick={commitName} style={{ height:36, padding:"0 16px", borderRadius:8,
                background:"#ffffff", border:"1px solid rgba(255,255,255,0.64)", color:"#1c1c1e", fontSize:13, fontWeight:500, cursor:"pointer", fontFamily:"inherit" }}>Save</button>
              <button onClick={() => setEditing(false)} style={{ height:36, padding:"0 12px", borderRadius:8,
                background:"rgba(0,0,0,0.06)", border:"none", color:"#6b7280", fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>Cancel</button>
            </div>
          ) : (
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:15, fontWeight:600, color:"#1c1c1e" }}>{displayName}</span>
              <button onClick={() => { setDraft(displayName); setEditing(true); }} style={{
                background:"none", border:"none", cursor:"pointer", padding:0,
                fontSize:12, color:"#9ca3af", textDecoration:"underline", fontFamily:"inherit",
              }}>Edit</button>
            </div>
          )}
        </div>
      </div>

      {/* Plan & License */}
      <SectionLabel>Plan &amp; license</SectionLabel>
      <div className="settings-card" style={{ padding:"16px 20px", marginBottom:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom: isPro ? 0 : 16, paddingBottom: isPro ? 0 : 16, borderBottom: isPro ? "none" : "1px solid #f4f4f5" }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:600, color:"#1c1c1e" }}>{isPro ? "TooEasy Pro" : "TooEasy Free"}</div>
            <div style={{ fontSize:12, color:"#9ca3af", marginTop:2 }}>{isPro ? "12 captures per session · unlimited gallery" : "3 captures per session"}</div>
          </div>
          {isPro ? (
            <span style={{ fontSize:12, fontWeight:600, color:"#16a34a",
              background:"#dcfce7", border:"1px solid #bbf7d0",
              padding:"4px 12px", borderRadius:999 }}>Pro</span>
          ) : (
            <button
              onClick={() => import("@tauri-apps/plugin-opener").then(m => m.openUrl("https://tooeasy.gumroad.com/l/pro")).catch(() => {})}
              style={{ height:32, padding:"0 14px", borderRadius:8,
                background:"#ffffff", border:"1px solid rgba(255,255,255,0.64)",
                color:"#1c1c1e", fontSize:13, fontWeight:600, cursor:"pointer" }}>Upgrade →</button>
          )}
        </div>

        {!isPro && (
          <div>
            <div style={{ fontSize:13, fontWeight:500, color:"#1c1c1e", marginBottom:8 }}>Have a license key?</div>
            <div style={{ display:"flex", gap:8 }}>
              <input
                value={licenseKey}
                onChange={e => { setLicenseKey(e.target.value); setLicenseError(null); }}
                onKeyDown={e => { if (e.key === "Enter") handleActivate(); }}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                style={{
                  flex:1, height:36, borderRadius:8,
                  border:`1px solid ${licenseError ? "rgba(239,68,68,0.6)" : "rgba(0,0,0,0.12)"}`,
                  padding:"0 12px", fontSize:12.5, fontFamily:"'SF Mono', monospace",
                  outline:"none", background:"rgba(255,255,255,0.8)", color:"#1c1c1e",
                  letterSpacing:"0.04em",
                }}
              />
              <button onClick={handleActivate} disabled={activating} style={{
                height:36, padding:"0 14px", borderRadius:8,
                background:"#1c1c1e", border:"none", color:"white",
                fontSize:13, fontWeight:500, cursor: activating ? "default" : "pointer",
                opacity: activating ? 0.6 : 1, fontFamily:"inherit", whiteSpace:"nowrap",
              }}>{activating ? "Checking…" : "Activate"}</button>
            </div>
            {licenseError && <p style={{ fontSize:12, color:"#ef4444", marginTop:6 }}>{licenseError}</p>}
          </div>
        )}

        {isPro && (
          <div style={{ marginTop:14, paddingTop:14, borderTop:"1px solid #f4f4f5" }}>
            <button onClick={handleDeactivate} disabled={deactivating} style={{
              background:"none", border:"none", padding:0, cursor:"pointer",
              fontSize:12, color:"#ef4444", fontFamily:"inherit",
            }}>{deactivating ? "Deactivating…" : "Deactivate license on this Mac"}</button>
            <p style={{ fontSize:11, color:"#9ca3af", marginTop:4 }}>Frees up this activation so you can use it on another Mac.</p>
          </div>
        )}
      </div>

      {/* Usage stats */}
      <SectionLabel>Usage</SectionLabel>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:16 }}>
        {[
          { label:"Total saved", value: totalCount },
          { label:"Today", value: todayCount },
          { label:"Favourites", value: favsCount },
        ].map(s => (
          <div key={s.label} className="settings-card" style={{ padding:"14px 16px" }}>
            <div style={{ fontSize:24, fontWeight:500, color:"#1c1c1e", lineHeight:1 }}>{s.value}</div>
            <div style={{ fontSize:11, color:"#9ca3af", marginTop:4 }}>{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────
type AiProvider = "anthropic" | "openai" | "groq";

function SettingsTab() {
  const [notifications, setNotifications] = useState(true);
  const [autoSave, setAutoSave]           = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(true);
  const [autoDismiss, setAutoDismiss]     = useState(() => localStorage.getItem("te_autoDismiss") !== "0");
  const [dismissTimer, setDismissTimer]   = useState(() => Number(localStorage.getItem("te_dismissTimer") ?? 30));
  const [isPro, setIsPro]                 = useState(false);

  const [aiProvider, setAiProvider] = useState<AiProvider>(
    () => (localStorage.getItem("te_ai_provider") as AiProvider) ?? "anthropic"
  );
  const [anthropicKey, setAnthropicKey] = useState(() => localStorage.getItem("te_ai_key_anthropic") ?? "");
  const [openaiKey, setOpenaiKey]       = useState(() => localStorage.getItem("te_ai_key_openai") ?? "");
  const [groqKey, setGroqKey]           = useState(() => localStorage.getItem("te_ai_key_groq") ?? "");
  const [showKey, setShowKey]           = useState(false);
  const [aiSaveStatus, setAiSaveStatus] = useState<"idle"|"saved"|"error">("idle");
  const aiSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function saveAiKey() {
    try {
      localStorage.setItem("te_ai_provider", aiProvider);
      localStorage.setItem("te_ai_key_anthropic", anthropicKey);
      localStorage.setItem("te_ai_key_openai", openaiKey);
      localStorage.setItem("te_ai_key_groq", groqKey);
      setAiSaveStatus("saved");
    } catch {
      setAiSaveStatus("error");
    }
    if (aiSaveTimer.current) clearTimeout(aiSaveTimer.current);
    aiSaveTimer.current = setTimeout(() => setAiSaveStatus("idle"), 2500);
  }

  const currentKey = aiProvider === "anthropic" ? anthropicKey : aiProvider === "openai" ? openaiKey : groqKey;
  const setCurrentKey = aiProvider === "anthropic" ? setAnthropicKey : aiProvider === "openai" ? setOpenaiKey : setGroqKey;

  useEffect(() => {
    import("../lib/tauri").then(m => m.getIsPro()).then(setIsPro).catch(() => {});
  }, []);
  useEffect(() => { localStorage.setItem("te_autoDismiss", autoDismiss ? "1" : "0"); }, [autoDismiss]);
  useEffect(() => { localStorage.setItem("te_dismissTimer", String(dismissTimer)); }, [dismissTimer]);
  useEffect(() => { localStorage.setItem("te_ai_provider", aiProvider); }, [aiProvider]);
  useEffect(() => { if (anthropicKey) localStorage.setItem("te_ai_key_anthropic", anthropicKey); }, [anthropicKey]);
  useEffect(() => { if (openaiKey)    localStorage.setItem("te_ai_key_openai",    openaiKey);    }, [openaiKey]);
  useEffect(() => { if (groqKey)      localStorage.setItem("te_ai_key_groq",      groqKey);      }, [groqKey]);

  const timerOptions = [10, 15, 30, 60, 120];

  const AI_PROVIDERS = [
    { id:"anthropic" as AiProvider, label:"Anthropic", icon:"ri-sparkling-2-fill", gradient:"linear-gradient(135deg,#d97757,#f59e0b)", hint:"console.anthropic.com", placeholder:"sk-ant-…" },
    { id:"openai"    as AiProvider, label:"OpenAI",    icon:"ri-openai-fill",       gradient:"linear-gradient(135deg,#4b5563,#111827)", hint:"platform.openai.com",   placeholder:"sk-…" },
    { id:"groq"      as AiProvider, label:"Groq",      icon:"ri-flashlight-fill",   gradient:"linear-gradient(135deg,#f97316,#ef4444)", hint:"console.groq.com",     placeholder:"gsk_…" },
  ];
  const activeProvider = AI_PROVIDERS.find(p => p.id === aiProvider)!;

  return (
    <div style={{ padding:"20px 20px 28px", maxWidth:520, margin:"0 auto" }}>

      {/* ── Plan banner ── */}
      <div className="settings-card" style={{ padding:"12px 16px", marginBottom:20, display:"flex", alignItems:"center", gap:12 }}>
        <div style={{ width:36, height:36, borderRadius:10, flexShrink:0,
          background:"rgba(255,255,255,0.44)",
          display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:15, fontWeight:700, color:"white" }}>T</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:600, color:"#1c1c1e" }}>TooEasy {isPro ? "Pro" : "Free"}</div>
          <div style={{ fontSize:11.5, color:"#9ca3af" }}>{isPro ? "Unlimited captures · Full gallery" : "3 captures per session"}</div>
        </div>
        {isPro
          ? <span style={{ fontSize:11, fontWeight:700, color:"#16a34a", background:"#dcfce7", border:"1px solid #bbf7d0", padding:"3px 10px", borderRadius:999 }}>Pro</span>
          : <button onClick={() => import("@tauri-apps/plugin-opener").then(m => m.openUrl("https://tooeasy.gumroad.com/l/pro")).catch(() => {})}
              style={{ height:28, padding:"0 12px", borderRadius:7, background:"#ffffff", border:"1px solid rgba(255,255,255,0.64)", color:"#1c1c1e", fontSize:12, fontWeight:600, cursor:"pointer", flexShrink:0 }}>
              Upgrade →
            </button>
        }
      </div>

      {/* ── General — 3-up icon tiles ── */}
      <SectionLabel>General</SectionLabel>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:16 }}>
        {([
          { label:"Launch at Login", icon:"ri-restart-fill",      grad:"linear-gradient(135deg,#ffffff,#e5e7eb)", val:launchAtLogin, set:setLaunchAtLogin },
          { label:"Auto-save",       icon:"ri-save-3-fill",        grad:"linear-gradient(135deg,#10b981,#059669)", val:autoSave,       set:setAutoSave },
          { label:"Notifications",   icon:"ri-notification-2-fill",grad:"linear-gradient(135deg,#f59e0b,#f97316)", val:notifications,  set:setNotifications },
        ] as { label:string; icon:string; grad:string; val:boolean; set:(v:boolean)=>void }[]).map(tile => (
          <div key={tile.label} className="settings-card" onClick={() => tile.set(!tile.val)}
            style={{ padding:"14px 14px 12px", cursor:"pointer", userSelect:"none" }}>
            <div style={{ width:32, height:32, borderRadius:9, marginBottom:10,
              background: tile.val ? tile.grad : "#f4f4f5",
              display:"flex", alignItems:"center", justifyContent:"center",
              transition:"background 200ms",
            }}>
              <Ri icon={tile.icon} gradient={tile.val ? "linear-gradient(135deg,#fff,rgba(255,255,255,0.85))" : "linear-gradient(135deg,#9ca3af,#6b7280)"} size={16} />
            </div>
            <div style={{ fontSize:12, fontWeight:600, color:"#1c1c1e", marginBottom:6, lineHeight:1.2 }}>{tile.label}</div>
            {/* Mini toggle */}
            <div style={{ width:32, height:18, borderRadius:999,
              background: tile.val ? "rgba(255,255,255,0.54)" : "#e4e4e7",
              position:"relative", transition:"background 200ms",
            }}>
              <div style={{ position:"absolute", top:2, left: tile.val ? 16 : 2,
                width:14, height:14, borderRadius:"50%", background:"#fff",
                boxShadow:"0 1px 3px rgba(0,0,0,0.25)",
                transition:"left 180ms cubic-bezier(0.34,1.56,0.64,1)",
              }} />
            </div>
          </div>
        ))}
      </div>

      {/* ── Panel Behavior ── */}
      <SectionLabel>Panel</SectionLabel>
      <div className="settings-card" style={{ marginBottom:16 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 14px", gap:12 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:28, height:28, borderRadius:7, flexShrink:0,
              background: autoDismiss ? "rgba(255,255,255,0.54)" : "#f4f4f5",
              display:"flex", alignItems:"center", justifyContent:"center", transition:"background 200ms" }}>
              <Ri icon="ri-timer-flash-fill" gradient={autoDismiss ? "linear-gradient(135deg,#fff,rgba(255,255,255,0.85))" : "linear-gradient(135deg,#9ca3af,#6b7280)"} size={14} />
            </div>
            <div>
              <div style={{ fontSize:13, fontWeight:500, color:"#1c1c1e" }}>Auto-dismiss</div>
              <div style={{ fontSize:11.5, color:"#9ca3af" }}>Hide panel after inactivity</div>
            </div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            {autoDismiss && (
              <div style={{ display:"flex", gap:4 }}>
                {timerOptions.map(sec => (
                  <button key={sec} onClick={() => setDismissTimer(sec)} style={{
                    height:24, padding:"0 8px", borderRadius:6, cursor:"pointer",
                    fontFamily:"inherit", fontSize:11, fontWeight:600,
                    background: dismissTimer === sec ? "#ffffff" : "#f4f4f5",
                    color: dismissTimer === sec ? "#1c1c1e" : "#6b7280",
                    border: dismissTimer === sec ? "none" : "1px solid rgba(0,0,0,0.08)",
                    transition:"background 120ms",
                  }}>{sec >= 60 ? `${sec/60}m` : `${sec}s`}</button>
                ))}
              </div>
            )}
            <div onClick={() => setAutoDismiss(v => !v)} style={{
              width:36, height:20, borderRadius:999, cursor:"pointer", flexShrink:0,
              background: autoDismiss ? "rgba(255,255,255,0.54)" : "#e4e4e7",
              position:"relative", transition:"background 200ms",
            }}>
              <div style={{ position:"absolute", top:3, left: autoDismiss ? 19 : 3,
                width:14, height:14, borderRadius:"50%", background:"#fff",
                boxShadow:"0 1px 3px rgba(0,0,0,0.25)",
                transition:"left 180ms cubic-bezier(0.34,1.56,0.64,1)",
              }} />
            </div>
          </div>
        </div>
      </div>

      {/* ── AI & API ── */}
      <SectionLabel>AI &amp; API</SectionLabel>
      <div className="settings-card" style={{ marginBottom:16, padding:"14px 14px" }}>
        {/* Provider pills */}
        <div style={{ display:"flex", gap:5, marginBottom:12 }}>
          {AI_PROVIDERS.map(p => {
            const active = aiProvider === p.id;
            return (
              <button key={p.id} onClick={() => { setAiProvider(p.id); setShowKey(false); }} style={{
                flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:6,
                height:32, borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:12, fontWeight:500,
                border: active ? "1.5px solid rgba(255,255,255,0.62)" : "1px solid rgba(0,0,0,0.08)",
                background: active ? "rgba(255,255,255,0.42)" : "#f9f9f9",
                color: active ? "#1c1c1e" : "#6b7280", transition:"all 120ms",
              }}>
                <Ri icon={p.icon} gradient={active ? "linear-gradient(135deg,#ffffff,#d1d5db)" : p.gradient} size={13} />
                {p.label}
              </button>
            );
          })}
        </div>
        {/* Key row */}
        <div style={{ display:"flex", gap:6 }}>
          <div style={{ flex:1, position:"relative" }}>
            <input
              type={showKey ? "text" : "password"}
              value={currentKey}
              onChange={e => setCurrentKey(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") saveAiKey(); }}
              placeholder={activeProvider.placeholder}
              style={{
                width:"100%", height:34, borderRadius:8,
                border:"1px solid rgba(0,0,0,0.12)",
                padding:"0 34px 0 10px", fontSize:12,
                fontFamily: currentKey ? "'SF Mono', monospace" : "inherit",
                outline:"none", background:"rgba(255,255,255,0.8)",
                color:"#1c1c1e", boxSizing:"border-box",
                letterSpacing: currentKey && !showKey ? "0.12em" : "normal",
              }}
            />
            <button onClick={() => setShowKey(v => !v)} style={{
              position:"absolute", right:7, top:"50%", transform:"translateY(-50%)",
              background:"none", border:"none", cursor:"pointer", padding:2, lineHeight:1,
            }}>
              <i className={showKey ? "ri-eye-off-line" : "ri-eye-line"}
                style={{ fontSize:14, color:"#9ca3af", WebkitTextFillColor:"#9ca3af" }} />
            </button>
          </div>
          <button onClick={saveAiKey} style={{
            height:34, padding:"0 14px", borderRadius:8, flexShrink:0,
            background: aiSaveStatus === "saved" ? "#10b981" : "#1c1c1e",
            border:"none", color:"white", fontSize:12, fontWeight:500,
            cursor:"pointer", fontFamily:"inherit", transition:"background 200ms", whiteSpace:"nowrap",
          }}>{aiSaveStatus === "saved" ? "Saved ✓" : "Save"}</button>
        </div>
        <p style={{ fontSize:11, color:"#9ca3af", margin:"7px 0 0", lineHeight:1.4 }}>
          <span style={{ color:"var(--gallery-text-1)" }}>{activeProvider.hint}</span> — stored locally only
        </p>
      </div>

      {/* ── Shortcuts ── */}
      <SectionLabel>Shortcuts</SectionLabel>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:20 }}>
        {[
          { label:"Capture",      key:"⌃⌘⇧4", icon:"ri-screenshot-fill", grad:"linear-gradient(135deg,#ffffff,#d1d5db)" },
          { label:"Save to disk", key:"⌘⇧4",  icon:"ri-download-2-fill", grad:"linear-gradient(135deg,#10b981,#059669)" },
        ].map(s => (
          <div key={s.label} className="settings-card" style={{ padding:"12px 14px" }}>
            <div style={{ width:28, height:28, borderRadius:7, marginBottom:8,
              background:s.grad, display:"flex", alignItems:"center", justifyContent:"center" }}>
              <Ri icon={s.icon} gradient="linear-gradient(135deg,#fff,rgba(255,255,255,0.85))" size={14} />
            </div>
            <div style={{ fontSize:11.5, fontWeight:500, color:"#6b7280", marginBottom:5 }}>{s.label}</div>
            <kbd style={{ display:"inline-block", padding:"2px 7px", borderRadius:5,
              background:"#f4f4f5", border:"1px solid rgba(0,0,0,0.08)",
              fontSize:11, color:"#1c1c1e", fontFamily:"inherit", letterSpacing:"0.02em" }}>{s.key}</kbd>
          </div>
        ))}
      </div>

      {/* ── About ── */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:6, padding:"4px 0 8px" }}>
        <div
          aria-label="TooEasy"
          role="img"
          style={{
            height:13,
            width:58,
            opacity:0.35,
            background:"var(--gallery-text-1)",
            mask:`url(${tooeasyWordmarkUrl}) center / contain no-repeat`,
            WebkitMask:`url(${tooeasyWordmarkUrl}) center / contain no-repeat`,
          }}
        />
        <span style={{ fontSize:11, color:"#c4c9d4" }}>·</span>
        <span style={{ fontSize:11, color:"#c4c9d4" }}>v1.0.0</span>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize:11, fontWeight:600, color:"#9ca3af", textTransform:"uppercase",
    letterSpacing:"0.06em", marginBottom:6, marginTop:4 }}>{children}</div>;
}


function EmptyState({ message }: { message?: string }) {
  return (
    <div style={{ textAlign:"center", padding:"80px 32px", color:"#9ca3af" }}>
      <Ri icon="ri-screenshot-fill" gradient="linear-gradient(135deg,#ffffff,#d1d5db)" size={48} style={{ display:"block", marginBottom:12 }} />
      <div style={{ fontSize:15, fontWeight:600, marginBottom:6, color:"#6b7280" }}>{message ?? "No screenshots yet"}</div>
      <div style={{ fontSize:13 }}>Press ⌃⌘⇧4 to capture your screen instantly</div>
    </div>
  );
}

// ── Onboarding ────────────────────────────────────────────────────────────────
function Onboarding({ onDone }: { onDone: ()=>void }) {
  const [step, setStep] = useState(0);

  const steps: { title: string; subtitle: string; custom: React.ReactNode; nextLabel?: string }[] = [
    {
      title: "Welcome to TooEasy",
      subtitle: "Capture your screen and paste directly into Claude, ChatGPT, or Figma — in one keystroke.",
      custom: (
        <div style={{ display:"flex", justifyContent:"center", gap:16, marginTop:8 }}>
          {["ri-sparkling-2-fill","ri-openai-fill","ri-figma-fill"].map((icon,i) => (
            <div key={i} style={{ width:44, height:44, borderRadius:12, background:"#f3f4f6",
              display:"flex", alignItems:"center", justifyContent:"center" }}>
              <i className={icon} style={{ fontSize:22, color:"#6b7280" }} />
            </div>
          ))}
        </div>
      ),
    },
    {
      title: "One-time setup",
      subtitle: "TooEasy needs Accessibility access to paste screenshots into other apps.",
      nextLabel: "I've allowed it",
      custom: (
        <div style={{ marginTop:4 }}>
          <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:16 }}>
            {[
              { n:"1", text:"Open System Settings → Privacy & Security → Accessibility" },
              { n:"2", text:"Toggle TooEasy on" },
              { n:"3", text:"Enter your Mac password when prompted" },
            ].map(row => (
              <div key={row.n} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                <div style={{ width:22, height:22, borderRadius:999, background:"#6366f1",
                  display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, marginTop:1 }}>
                  <span style={{ fontSize:11, fontWeight:700, color:"#fff" }}>{row.n}</span>
                </div>
                <span style={{ fontSize:13, color:"#374151", lineHeight:1.5 }}>{row.text}</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => openSystemSettings("accessibility").catch(()=>{})}
            style={{ width:"100%", height:40, borderRadius:10, background:"#6366f1",
              border:"none", color:"#fff", fontSize:13, fontWeight:600, cursor:"pointer" }}>
            Open System Settings →
          </button>
        </div>
      ),
    },
    {
      title: "Two ways to capture",
      subtitle: "Use whichever shortcut fits your flow.",
      custom: (
        <div style={{ display:"flex", flexDirection:"column", gap:8, marginTop:4 }}>
          {[
            { keys:["⌃","⌘","⇧","4"], label:"Copy to clipboard", badge:"Instant",
              desc:"TooEasy catches it immediately." },
            { keys:["⌘","⇧","4"], label:"Save to Desktop", badge:"~5 sec",
              desc:"TooEasy picks it up within seconds." },
          ].map(opt => (
            <div key={opt.label} style={{ background:"#f9f9fb", borderRadius:12, padding:"12px 14px" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
                <div style={{ display:"flex", gap:4 }}>
                  {opt.keys.map(k => (
                    <kbd key={k} style={{ padding:"3px 7px", borderRadius:6,
                      background:"#fff", border:"1px solid rgba(0,0,0,0.12)",
                      fontSize:12, fontWeight:600, color:"#1c1c1e", fontFamily:"inherit",
                      boxShadow:"0 1px 0 rgba(0,0,0,0.15)" }}>{k}</kbd>
                  ))}
                </div>
                <span style={{ fontSize:10, fontWeight:600, color:"#6b7280",
                  background:"#f3f4f6", padding:"2px 8px", borderRadius:999,
                  letterSpacing:"0.04em", textTransform:"uppercase" }}>{opt.badge}</span>
              </div>
              <div style={{ fontSize:13, fontWeight:600, color:"#1c1c1e", marginBottom:2 }}>{opt.label}</div>
              <div style={{ fontSize:12, color:"#9ca3af" }}>{opt.desc}</div>
            </div>
          ))}
        </div>
      ),
    },
    {
      title: "You're all set!",
      subtitle: "Take a screenshot, watch the panel appear, and paste anywhere with one click.",
      nextLabel: "Open TooEasy",
      custom: (
        <div style={{ display:"flex", flexDirection:"column", gap:10, marginTop:8 }}>
          {[
            { icon:"ri-screenshot-fill", label:"Take a screenshot" },
            { icon:"ri-checkbox-multiple-fill", label:"Select & bundle shots" },
            { icon:"ri-send-plane-fill", label:"Paste into any app" },
          ].map(row => (
            <div key={row.label} style={{ display:"flex", alignItems:"center", gap:12,
              background:"#f9f9fb", borderRadius:12, padding:"10px 14px" }}>
              <i className={row.icon} style={{ fontSize:18, color:"#6366f1" }} />
              <span style={{ fontSize:13, fontWeight:500, color:"#1c1c1e" }}>{row.label}</span>
            </div>
          ))}
        </div>
      ),
    },
  ];

  const s = steps[step];
  const isLast = step === steps.length - 1;

  return (
    <div style={{ minHeight:"100vh", background:"#f0f1f7",
      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:32 }}>
      <div style={{ width:400 }}>
        {/* Logo */}
        <div style={{ textAlign:"center", marginBottom:24 }}>
          <div style={{ width:56, height:56, borderRadius:16, margin:"0 auto 10px",
            background:"linear-gradient(135deg,#6366f1,#8b5cf6)",
            display:"flex", alignItems:"center", justifyContent:"center",
            boxShadow:"0 6px 24px rgba(99,102,241,0.40)" }}>
            <i className="ri-camera-fill" style={{ fontSize:26, color:"white", WebkitTextFillColor:"white" }} />
          </div>
          <div style={{ fontSize:13, fontWeight:600, color:"#9ca3af", letterSpacing:"0.06em", textTransform:"uppercase" }}>TooEasy</div>
        </div>

        {/* Card */}
        <div key={step} style={{ background:"#fff", borderRadius:20,
          padding:"24px 22px", marginBottom:18,
          boxShadow:"0 4px 24px rgba(0,0,0,0.09)",
          animation:"fade-up 240ms cubic-bezier(0.34,1.56,0.64,1) forwards" }}>
          <h2 style={{ fontSize:17, fontWeight:700, color:"#1c1c1e", margin:"0 0 6px" }}>{s.title}</h2>
          <p style={{ fontSize:13, color:"#6b7280", lineHeight:1.6, margin:"0 0 4px" }}>{s.subtitle}</p>
          {s.custom}
        </div>

        {/* Dots */}
        <div style={{ display:"flex", justifyContent:"center", gap:6, marginBottom:14 }}>
          {steps.map((_,i) => (
            <div key={i} style={{ width: i===step ? 18 : 6, height:6, borderRadius:999,
              background: i===step ? "#6366f1" : "#d1d5db",
              transition:"all 280ms cubic-bezier(0.34,1.56,0.64,1)" }} />
          ))}
        </div>

        {/* CTA */}
        <button onClick={() => isLast ? onDone() : setStep(step+1)} style={{
          width:"100%", height:46, borderRadius:12,
          background:"linear-gradient(135deg,#6366f1,#8b5cf6)",
          border:"none", color:"#fff", fontSize:15, fontWeight:600, cursor:"pointer",
          boxShadow:"0 4px 16px rgba(99,102,241,0.35)",
        }}>{s.nextLabel ?? (isLast ? "Get started" : "Continue")}</button>

        {step > 0 && (
          <button onClick={() => setStep(step-1)} style={{
            width:"100%", marginTop:10, background:"none", border:"none",
            color:"#9ca3af", fontSize:13, cursor:"pointer" }}>Back</button>
        )}
      </div>
    </div>
  );
}
