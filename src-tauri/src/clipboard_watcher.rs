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
            loop {
                std::thread::sleep(Duration::from_millis(150));
                let count = pasteboard_change_count();
                if count != last_change_count {
                    last_change_count = count;
                    if let Some(data_url) = read_image_from_pasteboard() {
                        let _ = std::fs::write("/tmp/tooeasy_watcher.log", "clipboard image\n");
                        show_image_panel(&app2, data_url);
                    }
                }
            }
        });
    }

    // Thread 2: FSEvents on Desktop (for Cmd+Shift+4 with thumbnail disabled)
    std::thread::spawn(move || {
        let desktop = match std::env::var_os("HOME").map(PathBuf::from) {
            Some(home) => home.join("Desktop"),
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
    {
        let state: State<AppState> = app.state();
        *state.pending_image.lock().unwrap() = Some(data_url.clone());
        let mut shots = state.session_screenshots.lock().unwrap();
        if !shots.iter().any(|shot| shot == &data_url) {
            if shots.len() >= 10 {
                shots.remove(0);
            }
            shots.push(data_url.clone());
        }
    }
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.show();
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

#[cfg(not(target_os = "macos"))]
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

        // Check for PNG first, then TIFF (macOS screenshots are TIFF)
        let types_to_try = ["public.png", "public.tiff", "com.adobe.pdf"];

        for type_str in &types_to_try {
            let ns_type = make_nsstring(type_str);
            let data: *mut Object = msg_send![pb, dataForType: ns_type];
            if data != cocoa::base::nil {
                let len: usize = msg_send![data, length];
                if len == 0 {
                    continue;
                }
                let bytes_ptr: *const u8 = msg_send![data, bytes];
                let bytes = std::slice::from_raw_parts(bytes_ptr, len);

                // If TIFF, convert to PNG via NSImage
                let final_bytes = if *type_str == "public.tiff" {
                    tiff_to_png(data).unwrap_or_else(|| bytes.to_vec())
                } else {
                    bytes.to_vec()
                };

                let b64 = base64::engine::general_purpose::STANDARD.encode(&final_bytes);
                let mime = if *type_str == "public.tiff" { "image/png" } else { "image/png" };
                return Some(format!("data:{mime};base64,{b64}"));
            }
        }
        None
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

#[cfg(target_os = "macos")]
unsafe fn tiff_to_png(tiff_data: *mut objc::runtime::Object) -> Option<Vec<u8>> {
    use objc::{class, msg_send, sel, sel_impl};

    // NSImage from TIFF data
    let ns_image: *mut objc::runtime::Object = msg_send![class!(NSImage), alloc];
    let ns_image: *mut objc::runtime::Object = msg_send![ns_image, initWithData: tiff_data];
    if ns_image == cocoa::base::nil {
        return None;
    }

    // Get PNG representation
    let bitmap_rep: *mut objc::runtime::Object =
        msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff_data];
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

#[cfg(not(target_os = "macos"))]
fn read_image_from_pasteboard() -> Option<String> {
    None
}
