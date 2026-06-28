import { useEffect, useRef, useState } from "react";

interface Props {
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  depth?: number;       // edge refraction depth in px (default 12)
  strength?: number;    // displacement scale (default 80)
  blur?: number;        // inner blur (default 0)
  tint?: string;        // overlay tint (default dark panel)
  borderRadius?: number;
  onClick?: () => void;
}

function buildDisplacementMap(w: number, h: number, r: number, depth: number) {
  const pct = (v: number, total: number) => Math.round((v / total) * 100);
  return (
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg height="${h}" width="${w}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
        <style>.mix{mix-blend-mode:screen}</style>
        <defs>
          <linearGradient id="Y" x1="0" x2="0"
            y1="${pct(r, h) * 0.15}%" y2="${100 - pct(r, h) * 0.15}%">
            <stop offset="0%" stop-color="#0F0"/>
            <stop offset="100%" stop-color="#000"/>
          </linearGradient>
          <linearGradient id="X" x1="${pct(r, w) * 0.15}%" x2="${100 - pct(r, w) * 0.15}%"
            y1="0" y2="0">
            <stop offset="0%" stop-color="#F00"/>
            <stop offset="100%" stop-color="#000"/>
          </linearGradient>
        </defs>
        <rect x="0" y="0" height="${h}" width="${w}" fill="#808080"/>
        <g filter="blur(2px)">
          <rect x="0" y="0" height="${h}" width="${w}" fill="#000080"/>
          <rect x="0" y="0" height="${h}" width="${w}" fill="url(#Y)" class="mix"/>
          <rect x="0" y="0" height="${h}" width="${w}" fill="url(#X)" class="mix"/>
          <rect x="${depth}" y="${depth}" height="${h - 2 * depth}" width="${w - 2 * depth}"
            fill="#808080" rx="${r}" ry="${r}" filter="blur(${depth}px)"/>
        </g>
      </svg>`
    )
  );
}

function buildFilter(w: number, h: number, r: number, depth: number, strength: number) {
  const dmap = buildDisplacementMap(w, h, r, depth);
  return (
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg height="${h}" width="${w}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="lg" color-interpolation-filters="sRGB">
            <feImage x="0" y="0" height="${h}" width="${w}" href="${dmap}" result="dmap"/>
            <feDisplacementMap in="SourceGraphic" in2="dmap"
              scale="${strength}" xChannelSelector="R" yChannelSelector="G"/>
          </filter>
        </defs>
      </svg>`
    ) +
    "#lg"
  );
}

// Detect if backdrop-filter:url() works (Chromium only)
const supportsFilterUrl = (() => {
  if (typeof document === "undefined") return false;
  const el = document.createElement("div");
  el.style.cssText = "backdrop-filter:url(#x)";
  return (
    el.style.backdropFilter === "url(#x)" ||
    el.style.backdropFilter === 'url("#x")'
  );
})();

export default function LiquidGlass({
  children,
  style,
  className,
  depth = 12,
  strength = 80,
  blur = 0,
  tint = "rgba(0,0,0,0.28)",
  borderRadius = 20,
  onClick,
}: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const glassRef   = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w > 0 && h > 0) setDims({ w, h });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const glass = glassRef.current;
    if (!glass || dims.w === 0) return;

    glass.style.width  = `${dims.w}px`;
    glass.style.height = `${dims.h}px`;

    if (supportsFilterUrl) {
      const filterUrl = buildFilter(dims.w, dims.h, borderRadius, depth, strength);
      glass.style.backdropFilter = [
        blur > 0 ? `blur(${blur / 2}px)` : "",
        `url('${filterUrl}')`,
        blur > 0 ? `blur(${blur}px)` : "",
        "brightness(1.08)",
        "saturate(160%)",
      ]
        .filter(Boolean)
        .join(" ");
    } else {
      // WebKit / WKWebView fallback — still beautiful
      glass.style.backdropFilter =
        `blur(${Math.max(12, dims.w / 20)}px) saturate(180%) brightness(1.06)`;
    }
  }, [dims, depth, strength, blur, borderRadius]);

  return (
    <div
      className={className}
      onClick={onClick}
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius,
        ...style,
      }}
    >
      {/* Tint overlay */}
      <div style={{
        position: "absolute", inset: 0, zIndex: 1,
        background: tint,
        borderRadius,
      }} />

      {/* Content */}
      <div ref={contentRef} style={{ position: "relative", zIndex: 3, width: "100%", height: "100%" }}>
        {children}
      </div>

      {/* Displacement + blur layer */}
      <div
        ref={glassRef}
        style={{
          position: "absolute", inset: 0, zIndex: 2,
          borderRadius,
          // WebKit fallback box-shadow rim
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.22), inset 0 1px 0 rgba(255,255,255,0.60)",
        }}
      />
    </div>
  );
}
