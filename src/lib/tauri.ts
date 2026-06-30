import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ActiveApp {
  bundle_id: string;
  name: string;
}

export interface ClipboardImageEvent {
  data_url: string;
  width: number;
  height: number;
}

export interface SavedScreenshot {
  filepath: string;
  filename: string;
}

export interface ScreenshotItem {
  filepath: string;
  filename: string;
  data_url: string;
  captured_at: string;
}

export const getLastActiveApp = (): Promise<ActiveApp> =>
  invoke("get_last_active_app");

export const getPendingImage = (): Promise<string | null> =>
  invoke("get_pending_image");

export const saveScreenshot = (
  dataUrl: string,
  appName: string
): Promise<SavedScreenshot> =>
  invoke("save_screenshot", { dataUrl, appName });

export const listScreenshots = (): Promise<ScreenshotItem[]> =>
  invoke("list_screenshots");

export const deleteScreenshot = (filepath: string): Promise<void> =>
  invoke("delete_screenshot", { filepath });

export const trashScreenshot = (filepath: string): Promise<void> =>
  invoke("trash_screenshot", { filepath });

export const editScreenshot = (filepath: string): Promise<void> =>
  invoke("edit_screenshot", { filepath });

export const pasteToApp = (
  dataUrl: string,
  bundleId: string
): Promise<void> => invoke("paste_to_app", { dataUrl, bundleId });

export const copyImage = (dataUrl: string): Promise<void> =>
  invoke("copy_image", { dataUrl });

export const pasteFileToApp = (filepath: string, bundleId: string): Promise<void> =>
  invoke("paste_file_to_app", { filepath, bundleId });

export const copyImageFile = (filepath: string): Promise<void> =>
  invoke("copy_image_file", { filepath });

export const addSessionScreenshot = (dataUrl: string): Promise<number> =>
  invoke("add_session_screenshot", { dataUrl });

export const getSessionScreenshots = (): Promise<string[]> =>
  invoke("get_session_screenshots");

export const removeSessionScreenshot = (index: number): Promise<void> =>
  invoke("remove_session_screenshot", { index });

export const clearSessionScreenshots = (): Promise<void> =>
  invoke("clear_session_screenshots");

export const getIsPro = (): Promise<boolean> => invoke("get_is_pro");
export const setIsPro = (value: boolean): Promise<void> => invoke("set_is_pro", { value });
export const activateLicense = (key: string): Promise<void> => invoke("activate_license", { key });
export const deactivateLicense = (): Promise<void> => invoke("deactivate_license");

export const copySelected = (dataUrls: string[]): Promise<void> =>
  invoke("copy_selected", { dataUrls });

export const pasteSelectedToApp = (dataUrls: string[], bundleId: string): Promise<void> =>
  invoke("paste_selected_to_app", { dataUrls, bundleId });

export const showPanel = (): Promise<void> => invoke("show_panel");
export const resizePanel = (height: number): Promise<void> =>
  invoke("resize_panel", { height });
export const hidePanel = (): Promise<void> => invoke("hide_panel");
export const showGallery = (): Promise<void> => invoke("show_gallery");

export const onClipboardImage = (
  handler: (event: ClipboardImageEvent) => void
) =>
  listen<ClipboardImageEvent>("clipboard-image", (e) => handler(e.payload));

export const onScreenshotsUpdated = (handler: () => void) =>
  listen("screenshots-updated", handler);

export const openSystemSettings = (section: "accessibility" | "security"): Promise<void> =>
  invoke("open_system_settings", { section });
