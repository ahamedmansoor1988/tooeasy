import { useEffect, useRef, useState } from "react";
import FloatingPanel from "../components/FloatingPanel";
import { onClipboardImage, getPendingImage, showPanel } from "../lib/tauri";
import type { ClipboardImageEvent } from "../lib/tauri";

export default function PanelPage() {
  const [currentEvent, setCurrentEvent] = useState<ClipboardImageEvent | null>(null);
  // Tracks last-set data_url so getPendingImage and the clipboard-image event
  // don't both fire for the same image (race condition in dev mode / fast loads).
  const lastDataUrlRef = useRef<string | null>(null);

  useEffect(() => {
    getPendingImage().then((dataUrl) => {
      if (dataUrl && dataUrl !== lastDataUrlRef.current) {
        lastDataUrlRef.current = dataUrl;
        setCurrentEvent({ data_url: dataUrl, width: 0, height: 0 });
      }
    }).catch(console.error);

    let unlisten: (() => void) | null = null;
    onClipboardImage(async (event) => {
      if (event.data_url !== lastDataUrlRef.current) {
        lastDataUrlRef.current = event.data_url;
        setCurrentEvent({ data_url: event.data_url, width: 0, height: 0 });
      }
      showPanel().catch(console.error);
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);

  return <FloatingPanel event={currentEvent} />;
}
