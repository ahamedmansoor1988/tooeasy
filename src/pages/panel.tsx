import { useEffect, useState } from "react";
import FloatingPanel from "../components/FloatingPanel";
import { onClipboardImage, getPendingImage, showPanel } from "../lib/tauri";
import type { ClipboardImageEvent } from "../lib/tauri";

export default function PanelPage() {
  const [currentEvent, setCurrentEvent] = useState<ClipboardImageEvent | null>(null);

  useEffect(() => {
    getPendingImage().then((dataUrl) => {
      if (dataUrl) setCurrentEvent({ data_url: dataUrl, width: 0, height: 0 });
    }).catch(console.error);

    let unlisten: (() => void) | null = null;
    onClipboardImage(async (event) => {
      setCurrentEvent({ data_url: event.data_url, width: 0, height: 0 });
      showPanel().catch(console.error);
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);

  return <FloatingPanel event={currentEvent} />;
}
