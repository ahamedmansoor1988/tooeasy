use crate::AppState;
use notify::{Event, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, serde::Serialize)]
pub struct ClipboardImageEvent {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

pub fn start(app: AppHandle) {
    // Thread 1: clipboard polling (for Cmd+Ctrl+Shift+4 and browser "Copy Image")
    {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let _ = std::fs::write("/tmp/tooeasy_watcher.log", "watcher started\n");
            // Initialize to current count so we don't fire on existing clipboard content
            let mut last_change_count: i64 = pasteboard_change_count();
            // Debounce: wait for the clipboard to settle before reading.
            // Chrome's "Copy Image" does a two-step write (clear + set image) that
            // increments changeCount twice. By waiting 150 ms after the LAST change,
            // we always read the final state — one read, correct data, no duplicates.
            // Two genuinely different images copied > 150 ms apart both register.
            let mut pending_since: Option<std::time::Instant> = None;
            loop {
                std::thread::sleep(Duration::from_millis(50));
                let count = pasteboard_change_count();
                if count != last_change_count {
                    last_change_count = count;
                    pending_since = Some(std::time::Instant::now()); // reset settle timer
                }
                if let Some(since) = pending_since {
                    if since.elapsed() >= Duration::from_millis(150) {
                        pending_since = None;
                        // Skip if a paste command suppressed the watcher to avoid echoing back.
                        let suppressed = {
                            let state: tauri::State<crate::AppState> = app2.state();
                            let until = *state.suppress_watcher_until.lock().unwrap();
                            until.map_or(false, |t| std::time::Instant::now() < t)
                        };
                        if suppressed { continue; }
                        if let Some(data_url) = read_image_from_pasteboard() {
                            let _ = std::fs::write("/tmp/tooeasy_watcher.log", "clipboard image\n");
                            show_image_panel(&app2, data_url);
                        } else {
                            // Log what IS on the clipboard so we can debug missed images
                            log_pasteboard_types();
                        }
                    }
                }
            }
        });
    }

    // Thread 2: watch screenshots folder (Desktop on macOS, Pictures/Screenshots on Windows)
    std::thread::spawn(move || {
        let desktop = {
            #[cfg(target_os = "macos")]
            { std::env::var_os("HOME").map(PathBuf::from).map(|h| h.join("Desktop")) }
            #[cfg(target_os = "windows")]
            { std::env::var_os("USERPROFILE").map(PathBuf::from).map(|h| h.join("Pictures").join("Screenshots")) }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            { None::<PathBuf> }
        };
        let desktop = match desktop {
            Some(d) => d,
            None => return,
        };

        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(_) => return,
        };
        if watcher.watch(&desktop, RecursiveMode::NonRecursive).is_err() {
            return;
        }

        let _ = std::fs::write("/tmp/tooeasy_watcher.log", "FSEvents watching Desktop\n");

        let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
        // Drain any events that fire immediately on startup (existing files)
        let startup = std::time::Instant::now();

        for res in rx {
            // Ignore events in the first 3 seconds — these are for pre-existing files
            if startup.elapsed().as_secs() < 3 {
                continue;
            }
            if let Ok(event) = res {
                // Log every event for debugging
                let _ = std::fs::write("/tmp/tooeasy_watcher.log",
                    format!("FSEvent: {:?} {:?}\n", event.kind, event.paths));

                for path in event.paths {
                    let name = path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();

                    let is_screenshot = name.starts_with("Screenshot ")
                        && path.extension()
                            .is_some_and(|e| e.eq_ignore_ascii_case("png"));

                    if is_screenshot && !seen.contains(&path) {
                        seen.insert(path.clone());
                        std::thread::sleep(Duration::from_millis(200));
                        let _ = std::fs::write("/tmp/tooeasy_watcher.log",
                            format!("FSEvents: {name}\n"));
                        show_panel_with_file(&app, path.to_string_lossy().to_string());
                    }
                }
            }
        }
    });
}

fn show_image_panel(app: &AppHandle, data_url: String) {
    enum AddResult { Added, Duplicate, AtCap }
    let result = {
        let state: State<AppState> = app.state();
        *state.pending_image.lock().unwrap() = Some(data_url.clone());
        let is_pro = *state.is_pro.lock().unwrap();
        let limit = if is_pro { crate::PRO_LIMIT } else { crate::FREE_LIMIT };
        let mut shots = state.session_screenshots.lock().unwrap();
        if shots.iter().any(|shot| shot == &data_url) {
            AddResult::Duplicate
        } else if shots.len() >= limit {
            AddResult::AtCap
        } else {
            shots.push(data_url.clone());
            AddResult::Added
        }
    };
    match result {
        AddResult::Duplicate => return,
        AddResult::AtCap => {
            if let Some(panel) = app.get_webview_window("panel") {
                let _ = panel.show();
                let _ = panel.set_focus();
                let _ = app.emit("screenshot-cap-reached", ());
            } else {
                crate::create_panel_window(app);
                // Delay emission so the panel has time to mount and register its listener
                let app2 = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    let _ = app2.emit("screenshot-cap-reached", ());
                });
            }
            return;
        }
        AddResult::Added => {}
    }
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.show();
        let _ = panel.set_focus();
    } else {
        crate::create_panel_window(app);
    }
    let _ = app.emit("clipboard-image", ClipboardImageEvent { data_url, width: 0, height: 0 });
    let _ = std::fs::write("/tmp/tooeasy_watcher.log", "emitted event\n");
}

fn show_panel_with_file(app: &AppHandle, path: String) {
    use base64::Engine;
    if let Ok(bytes) = std::fs::read(&path) {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let data_url = format!("data:image/png;base64,{b64}");
        show_image_panel(app, data_url);
    }
}



#[cfg(target_os = "macos")]
fn log_pasteboard_types() {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let pb: *mut Object = msg_send![class!(NSPasteboard), generalPasteboard];
        let types: *mut Object = msg_send![pb, types];
        let count: usize = msg_send![types, count];
        let mut type_list = String::new();
        for i in 0..count {
            let t: *mut Object = msg_send![types, objectAtIndex: i];
            let cstr: *const std::os::raw::c_char = msg_send![t, UTF8String];
            if !cstr.is_null() {
                let s = std::ffi::CStr::from_ptr(cstr).to_string_lossy();
                type_list.push_str(&format!("  {s}\n"));
            }
        }
        let _ = std::fs::write("/tmp/tooeasy_watcher.log", format!("clipboard types:\n{type_list}"));
    }
}

#[cfg(not(target_os = "macos"))]
fn log_pasteboard_types() {}

#[cfg(target_os = "macos")]
fn pasteboard_change_count() -> i64 {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let pb: *mut Object = msg_send![class!(NSPasteboard), generalPasteboard];
        msg_send![pb, changeCount]
    }
}

#[cfg(target_os = "windows")]
fn pasteboard_change_count() -> i64 {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    unsafe { GetClipboardSequenceNumber() as i64 }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn pasteboard_change_count() -> i64 {
    0
}

#[cfg(target_os = "macos")]
fn read_image_from_pasteboard() -> Option<String> {
    use base64::Engine;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let pb: *mut Object = msg_send![class!(NSPasteboard), generalPasteboard];

        // NSImage.initWithPasteboard: is the correct macOS API for reading an
        // image from the clipboard regardless of format. It handles PNG, TIFF,
        // JPEG, WebP, HEIF — and crucially, whatever proprietary type Chrome or
        // Safari puts there when the user picks "Copy Image" on a webpage.
        // Returns nil when the clipboard contains only text or non-image data.
        let ns_image: *mut Object = msg_send![class!(NSImage), alloc];
        let ns_image: *mut Object = msg_send![ns_image, initWithPasteboard: pb];
        if ns_image == cocoa::base::nil {
            return None;
        }

        // NSImage → TIFF intermediate → NSBitmapImageRep → PNG bytes
        let tiff: *mut Object = msg_send![ns_image, TIFFRepresentation];
        if tiff == cocoa::base::nil {
            return None;
        }
        let bitmap: *mut Object =
            msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
        if bitmap == cocoa::base::nil {
            return None;
        }
        let props: *mut Object = msg_send![class!(NSDictionary), dictionary];
        // NSBitmapImageFileTypePNG = 4
        let png: *mut Object =
            msg_send![bitmap, representationUsingType:4usize properties:props];
        if png == cocoa::base::nil {
            return None;
        }
        let len: usize = msg_send![png, length];
        let ptr: *const u8 = msg_send![png, bytes];
        let bytes = std::slice::from_raw_parts(ptr, len).to_vec();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Some(format!("data:image/png;base64,{b64}"))
    }
}

#[cfg(target_os = "macos")]
unsafe fn make_nsstring(s: &str) -> *mut objc::runtime::Object {
    use objc::{class, msg_send, sel, sel_impl};
    let cls = class!(NSString);
    let ns: *mut objc::runtime::Object = msg_send![cls, alloc];
    let bytes = s.as_ptr() as *const std::os::raw::c_void;
    let len = s.len();
    // UTF8 encoding = 4
    let ns: *mut objc::runtime::Object =
        msg_send![ns, initWithBytes:bytes length:len encoding:4u64];
    ns
}

// Convert any image format (TIFF, JPEG, GIF, BMP …) to PNG bytes.
// Uses NSImage as the universal decoder so every format macOS supports works.
#[cfg(target_os = "macos")]
unsafe fn any_image_to_png(image_data: *mut objc::runtime::Object) -> Option<Vec<u8>> {
    use objc::{class, msg_send, sel, sel_impl};

    // 1. Load into NSImage — works for every format the OS ships with.
    let ns_image: *mut objc::runtime::Object = msg_send![class!(NSImage), alloc];
    let ns_image: *mut objc::runtime::Object = msg_send![ns_image, initWithData: image_data];
    if ns_image == cocoa::base::nil {
        return None;
    }

    // 2. Render into a bitmap rep via the TIFF round-trip
    //    (NSImage → TIFF intermediate → NSBitmapImageRep → PNG).
    //    This preserves full resolution even for non-TIFF sources.
    let tiff_rep: *mut objc::runtime::Object = msg_send![ns_image, TIFFRepresentation];
    if tiff_rep == cocoa::base::nil {
        return None;
    }
    let bitmap_rep: *mut objc::runtime::Object =
        msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff_rep];
    if bitmap_rep == cocoa::base::nil {
        return None;
    }

    // NSBitmapImageFileTypePNG = 4
    let props: *mut objc::runtime::Object = msg_send![class!(NSDictionary), dictionary];
    let png_data: *mut objc::runtime::Object =
        msg_send![bitmap_rep, representationUsingType:4usize properties:props];
    if png_data == cocoa::base::nil {
        return None;
    }

    let len: usize = msg_send![png_data, length];
    let ptr: *const u8 = msg_send![png_data, bytes];
    Some(std::slice::from_raw_parts(ptr, len).to_vec())
}

#[cfg(target_os = "windows")]
fn read_image_from_pasteboard() -> Option<String> {
    use base64::Engine;
    let mut cb = arboard::Clipboard::new().ok()?;
    let img = cb.get_image().ok()?;
    let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.to_vec())?;
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut buf, image::ImageFormat::Png)
        .ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    Some(format!("data:image/png;base64,{b64}"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn read_image_from_pasteboard() -> Option<String> {
    None
}
