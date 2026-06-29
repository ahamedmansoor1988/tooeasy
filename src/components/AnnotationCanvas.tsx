import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ScreenshotItem } from "../lib/tauri";

type Tool = "pen" | "arrow" | "rect" | "text";
type Color = string;

interface TextInput {
  x: number;
  y: number;
  value: string;
}

interface Props {
  screenshot: ScreenshotItem;
  onClose: () => void;
}

export default function AnnotationCanvas({ screenshot, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState<Color>("#FF3B30");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [textInput, setTextInput] = useState<TextInput | null>(null);
  const [textValue, setTextValue] = useState("");
  const drawing = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const snapshot = useRef<ImageData | null>(null);

  useEffect(() => {
    let blobUrl = "";
    fetch(convertFileSrc(screenshot.filepath))
      .then(r => r.blob())
      .then(blob => {
        blobUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          imgRef.current = img;
          const canvas = canvasRef.current;
          if (!canvas) return;
          // Size canvas to actual image dimensions
          canvas.width  = img.naturalWidth;
          canvas.height = img.naturalHeight;
          if (overlayRef.current) {
            overlayRef.current.width  = img.naturalWidth;
            overlayRef.current.height = img.naturalHeight;
          }
          canvas.getContext("2d")!.drawImage(img, 0, 0);
        };
        img.src = blobUrl;
      })
      .catch(console.error);
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [screenshot.filepath]);

  function getPos(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = overlayRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (tool === "text") {
      const pos = getPos(e);
      setTextInput({ x: pos.x, y: pos.y, value: "" });
      setTextValue("");
      return;
    }
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    snapshot.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    drawing.current = true;
    startPos.current = getPos(e);

    if (tool === "pen") {
      ctx.beginPath();
      ctx.moveTo(startPos.current.x, startPos.current.y);
    }
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const pos = getPos(e);

    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (tool === "pen") {
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    } else {
      if (snapshot.current) ctx.putImageData(snapshot.current, 0, 0);
      const sx = startPos.current.x;
      const sy = startPos.current.y;

      if (tool === "rect") {
        ctx.beginPath();
        ctx.rect(sx, sy, pos.x - sx, pos.y - sy);
        ctx.stroke();
      } else if (tool === "arrow") {
        drawArrow(ctx, sx, sy, pos.x, pos.y, color, strokeWidth);
      }
    }
  }

  function onMouseUp() {
    drawing.current = false;
    snapshot.current = null;
  }

  function commitText() {
    if (!textInput || !textValue.trim()) {
      setTextInput(null);
      return;
    }
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.font = `${strokeWidth * 6 + 12}px -apple-system, sans-serif`;
    ctx.fillText(textValue, textInput.x, textInput.y);
    setTextInput(null);
    setTextValue("");
  }

  function handleSave() {
    const canvas = canvasRef.current!;
    const dataUrl = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `annotated_${screenshot.filename}`;
    a.click();
  }

  const COLORS = ["#FF3B30", "#FF9500", "#FFCC00", "#34C759", "#007AFF", "#FFFFFF", "#000000"];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        display: "flex",
        flexDirection: "column",
        zIndex: 1000,
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 16px",
          background: "rgba(30,30,30,0.95)",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
          flexWrap: "wrap",
        }}
      >
        {/* Tools */}
        {(["pen", "arrow", "rect", "text"] as Tool[]).map((t) => (
          <button
            key={t}
            onClick={() => setTool(t)}
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              background: tool === t ? "rgba(0,122,255,0.3)" : "rgba(255,255,255,0.07)",
              border: `1px solid ${tool === t ? "rgba(0,122,255,0.7)" : "rgba(255,255,255,0.12)"}`,
              color: "white",
            }}
          >
            {t === "pen" ? "✏️ Draw" : t === "arrow" ? "→ Arrow" : t === "rect" ? "▭ Rect" : "T Text"}
          </button>
        ))}

        <div style={{ width: 1, height: 24, background: "rgba(255,255,255,0.15)" }} />

        {/* Colors */}
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: c,
              border: color === c ? "2px solid white" : "2px solid transparent",
              cursor: "pointer",
              outline: "none",
            }}
          />
        ))}

        <div style={{ width: 1, height: 24, background: "rgba(255,255,255,0.15)" }} />

        {/* Stroke width */}
        <input
          type="range"
          min={1}
          max={8}
          value={strokeWidth}
          onChange={(e) => setStrokeWidth(Number(e.target.value))}
          style={{ width: 80 }}
        />

        <div style={{ flex: 1 }} />

        <button
          onClick={handleSave}
          style={{
            padding: "5px 12px",
            borderRadius: 6,
            fontSize: 12,
            cursor: "pointer",
            background: "rgba(52,199,89,0.2)",
            border: "1px solid rgba(52,199,89,0.5)",
            color: "white",
          }}
        >
          Save
        </button>
        <button
          onClick={onClose}
          style={{
            padding: "5px 12px",
            borderRadius: 6,
            fontSize: 12,
            cursor: "pointer",
            background: "rgba(255,255,255,0.07)",
            border: "1px solid rgba(255,255,255,0.15)",
            color: "rgba(255,255,255,0.6)",
          }}
        >
          Close
        </button>
      </div>

      {/* Canvas area */}
      <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ position: "relative" }}>
          <canvas
            ref={canvasRef}
            width={1280}
            height={800}
            style={{ display: "block", maxWidth: "100%", maxHeight: "calc(100vh - 120px)", objectFit: "contain" }}
          />
          {/* Overlay for mouse events */}
          <canvas
            ref={overlayRef}
            width={1280}
            height={800}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            style={{
              position: "absolute",
              inset: 0,
              opacity: 0,
              cursor: tool === "text" ? "text" : "crosshair",
              width: "100%",
              height: "100%",
            }}
          />
          {/* Text input */}
          {textInput && (
            <input
              autoFocus
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitText();
                if (e.key === "Escape") setTextInput(null);
              }}
              onBlur={commitText}
              style={{
                position: "absolute",
                left: (textInput.x / 1280) * 100 + "%",
                top: (textInput.y / 800) * 100 + "%",
                background: "transparent",
                border: "1px dashed rgba(255,255,255,0.5)",
                color: color,
                fontSize: strokeWidth * 6 + 12,
                fontFamily: "-apple-system, sans-serif",
                outline: "none",
                minWidth: 80,
                padding: "2px 4px",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string,
  width: number
) {
  const headLen = Math.max(12, width * 4);
  const angle = Math.atan2(toY - fromY, toX - fromX);

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - headLen * Math.cos(angle - Math.PI / 6),
    toY - headLen * Math.sin(angle - Math.PI / 6)
  );
  ctx.lineTo(
    toX - headLen * Math.cos(angle + Math.PI / 6),
    toY - headLen * Math.sin(angle + Math.PI / 6)
  );
  ctx.closePath();
  ctx.fill();
}
