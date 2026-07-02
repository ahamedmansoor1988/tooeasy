mod active_app_detector;
mod clipboard_watcher;
mod file_manager;
mod license_manager;
mod paste_manager;

use active_app_detector::ActiveApp;
use std::sync::Mutex;
use tauri::{
    image::Image,
    LogicalPosition, LogicalSize,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::{Effect, EffectState, EffectsBuilder},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};

// ── OCR ───────────────────────────────────────────────────────────────────────
#[derive(serde::Serialize)]
struct OcrLine { text: String, y: f64, h: f64 }

#[cfg(target_os = "macos")]
#[repr(C)] #[derive(Copy, Clone)] struct CGPoint { x: f64, y: f64 }
#[cfg(target_os = "macos")]
#[repr(C)] #[derive(Copy, Clone)] struct CGSize  { width: f64, height: f64 }
#[cfg(target_os = "macos")]
#[repr(C)] #[derive(Copy, Clone)] struct CGRect  { origin: CGPoint, size: CGSize }

#[tauri::command]
#[cfg(target_os = "macos")]
fn ocr_image(filepath: String) -> Result<Vec<OcrLine>, String> {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let c = std::ffi::CString::new(filepath).map_err(|e| e.to_string())?;
        let ns_path: *mut Object = msg_send![class!(NSString), stringWithUTF8String: c.as_ptr()];
        let file_url: *mut Object = msg_send![class!(NSURL), fileURLWithPath: ns_path];
        let request: *mut Object = msg_send![class!(VNRecognizeTextRequest), new];
        let _: () = msg_send![request, setRecognitionLevel: 0isize];
        let opts: *mut Object  = msg_send![class!(NSDictionary), dictionary];
        let handler: *mut Object = msg_send![class!(VNImageRequestHandler), alloc];
        let handler: *mut Object = msg_send![handler, initWithURL: file_url options: opts];
        let arr: *mut Object = msg_send![class!(NSMutableArray), new];
        let _: () = msg_send![arr, addObject: request];
        let _: bool = msg_send![handler, performRequests: arr error: std::ptr::null_mut::<*mut Object>()];
        let results: *mut Object = msg_send![request, results];
        if results.is_null() { return Ok(vec![]); }
        let count: usize = msg_send![results, count];
        let mut lines: Vec<OcrLine> = Vec::new();
        for i in 0..count {
            let obs: *mut Object  = msg_send![results, objectAtIndex: i];
            let bbox: CGRect      = msg_send![obs, boundingBox];
            let y_top = (1.0_f64 - bbox.origin.y - bbox.size.height).max(0.0_f64);
            let cands: *mut Object = msg_send![obs, topCandidates: 1usize];
            let cc: usize          = msg_send![cands, count];
            if cc == 0 { continue; }
            let cand: *mut Object  = msg_send![cands, objectAtIndex: 0usize];
            let ns_s: *mut Object  = msg_send![cand, string];
            let ptr: *const std::os::raw::c_char = msg_send![ns_s, UTF8String];
            if ptr.is_null() { continue; }
            let text = std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned();
            lines.push(OcrLine { text, y: y_top, h: bbox.size.height });
        }
        lines.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap_or(std::cmp::Ordering::Equal));
        Ok(lines)
    }
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
fn ocr_image(_filepath: String) -> Result<Vec<OcrLine>, String> {
    Ok(vec![])
}

#[tauri::command]
fn ocr_data_url(data_url: String) -> Result<Vec<OcrLine>, String> {
    use base64::{engine::general_purpose, Engine};
    let b64 = data_url.splitn(2, ',').nth(1).ok_or("Invalid data URL")?;
    let bytes = general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    let tmp_path = std::env::temp_dir().join(format!("te_ocr_{}.png",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default().as_nanos()));
    std::fs::write(&tmp_path, &bytes).map_err(|e| e.to_string())?;
    let result = ocr_image(tmp_path.to_string_lossy().into_owned());
    let _ = std::fs::remove_file(&tmp_path);
    result
}
// ─────────────────────────────────────────────────────────────────────────────

const PANEL_WIDTH: f64 = 320.0;
const PANEL_HEIGHT: f64 = 458.0;
const PANEL_MIN_HEIGHT: f64 = PANEL_HEIGHT;
const PANEL_FILLED_BASE_HEIGHT: f64 = 476.0;
const PANEL_THUMBNAIL_ROW_HEIGHT: f64 = 80.0;
const PANEL_MAX_VISIBLE_SHOTS: usize = 20; // = PRO_LIMIT (defined below)
const GALLERY_WIDTH: f64 = 940.0;
const GALLERY_HEIGHT: f64 = 640.0;

pub const FREE_LIMIT: usize  = 6;
pub const PRO_LIMIT: usize   = 20;

pub struct AppState {
    pub last_active_app: Mutex<ActiveApp>,
    pub pending_image: Mutex<Option<String>>,
    pub session_screenshots: Mutex<Vec<String>>,
    pub is_pro: Mutex<bool>,
    // Set by paste commands so the clipboard watcher ignores the write-back.
    pub suppress_watcher_until: Mutex<Option<std::time::Instant>>,
}

#[tauri::command]
fn get_last_active_app(state: State<AppState>) -> ActiveApp {
    state.last_active_app.lock().unwrap().clone()
}

#[tauri::command]
fn save_screenshot(
    app: AppHandle,
    data_url: String,
    app_name: String,
) -> Result<serde_json::Value, String> {
    let saved = file_manager::save_screenshot(&data_url, &app_name)?;
    let _ = app.emit("screenshots-updated", ());
    Ok(serde_json::json!({
        "filepath": saved.filepath,
        "filename": saved.filename,
    }))
}

#[tauri::command]
fn list_screenshots() -> Result<Vec<file_manager::ScreenshotItem>, String> {
    file_manager::list_screenshots()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn delete_screenshot(app: AppHandle, filepath: String) -> Result<(), String> {
    file_manager::delete_screenshot(&filepath)?;
    let _ = app.emit("screenshots-updated", ());
    Ok(())
}

#[tauri::command]
fn trash_screenshot(app: AppHandle, filepath: String) -> Result<(), String> {
    file_manager::trash_screenshot(&filepath)?;
    let _ = app.emit("screenshots-updated", ());
    Ok(())
}

#[tauri::command]
fn edit_screenshot(filepath: String) -> Result<(), String> {
    file_manager::edit_screenshot(&filepath)
}

#[tauri::command]
fn paste_to_app(app: AppHandle, data_url: String, bundle_id: String) -> Result<(), String> {
    suppress_watcher(&app, 800);
    paste_manager::paste_to_app(&data_url, &bundle_id)
}

#[tauri::command]
fn copy_image(data_url: String) -> Result<(), String> {
    paste_manager::copy_image(&data_url)
}

#[tauri::command]
fn paste_file_to_app(filepath: String, bundle_id: String) -> Result<(), String> {
    paste_manager::paste_file_to_app(&filepath, &bundle_id)
}

#[tauri::command]
fn copy_image_file(filepath: String) -> Result<(), String> {
    paste_manager::copy_image_file(&filepath)
}

#[tauri::command]
fn get_pending_image(state: State<AppState>) -> Option<String> {
    state.pending_image.lock().unwrap().clone()
}

// Session screenshot commands — called by frontend when a new clipboard event fires
#[tauri::command]
fn add_session_screenshot(state: State<AppState>, data_url: String) -> Result<usize, String> {
    let is_pro = *state.is_pro.lock().unwrap();
    let limit = if is_pro { PRO_LIMIT } else { FREE_LIMIT };
    let mut shots = state.session_screenshots.lock().unwrap();
    if shots.iter().any(|s| s == &data_url) {
        return Ok(shots.len());
    }
    if shots.len() >= limit {
        return Ok(shots.len()); // silently drop — UI already shows the cap
    }
    shots.push(data_url);
    Ok(shots.len())
}

#[tauri::command]
fn get_is_pro(state: State<AppState>) -> bool {
    *state.is_pro.lock().unwrap()
}

#[tauri::command]
fn set_is_pro(state: State<AppState>, value: bool) {
    *state.is_pro.lock().unwrap() = value;
}

/// Validate a license key and, if valid, persist it and set is_pro = true.
#[tauri::command]
fn activate_license(state: State<AppState>, key: String) -> Result<(), String> {
    match license_manager::verify_key(&key) {
        Ok(true) => {
            license_manager::save_license(&key)?;
            *state.is_pro.lock().unwrap() = true;
            Ok(())
        }
        Ok(false) => Err("Invalid license key. Please check and try again.".to_string()),
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn deactivate_license(state: State<AppState>) -> Result<(), String> {
    license_manager::remove_license()?;
    *state.is_pro.lock().unwrap() = false;
    Ok(())
}

#[tauri::command]
fn get_session_screenshots(state: State<AppState>) -> Vec<String> {
    state.session_screenshots.lock().unwrap().clone()
}

#[tauri::command]
fn remove_session_screenshot(state: State<AppState>, index: usize) -> Result<(), String> {
    let mut shots = state.session_screenshots.lock().unwrap();
    if index < shots.len() {
        shots.remove(index);
    }
    Ok(())
}

#[tauri::command]
fn clear_session_screenshots(state: State<AppState>) {
    state.session_screenshots.lock().unwrap().clear();
}

// Copy selected screenshots (stitched into one) to clipboard
#[tauri::command]
fn copy_selected(data_urls: Vec<String>) -> Result<(), String> {
    if data_urls.is_empty() {
        return Err("No screenshots selected".into());
    }
    paste_manager::copy_images_stitched(&data_urls)
}

// Paste each selected screenshot separately into the app (one Cmd+V per image)
#[tauri::command]
fn paste_selected_to_app(app: AppHandle, data_urls: Vec<String>, bundle_id: String) -> Result<(), String> {
    if data_urls.is_empty() {
        return Err("No screenshots selected".into());
    }
    // Each image takes ~650ms to paste; suppress the clipboard watcher for the full duration
    let suppress_ms = (data_urls.len() as u64) * 800 + 600;
    suppress_watcher(&app, suppress_ms);
    paste_manager::paste_images_sequential(&data_urls, &bundle_id)
}

fn suppress_watcher(app: &AppHandle, millis: u64) {
    if let Some(state) = app.try_state::<AppState>() {
        *state.suppress_watcher_until.lock().unwrap() =
            Some(std::time::Instant::now() + std::time::Duration::from_millis(millis));
    }
}

fn panel_position(app: &AppHandle) -> (f64, f64) {
    let (sw, _sh) = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let s = m.scale_factor();
            (
                (m.size().width as f64 / s) as i32,
                (m.size().height as f64 / s) as i32,
            )
        })
        .unwrap_or((1440, 900));

    ((sw as f64 - PANEL_WIDTH - 20.0).max(0.0), 20.0_f64)
}

fn gallery_position(app: &AppHandle) -> (f64, f64) {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let s = m.scale_factor();
            let size = m.size();
            let pos = m.position();
            let sw = size.width as f64 / s;
            let sh = size.height as f64 / s;
            let px = pos.x as f64 / s;
            let py = pos.y as f64 / s;
            (
                px + ((sw - GALLERY_WIDTH) / 2.0).max(16.0),
                py + ((sh - GALLERY_HEIGHT) / 2.0).max(16.0),
            )
        })
        .unwrap_or((120.0, 90.0))
}

fn fit_panel_window(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.set_size(LogicalSize::new(PANEL_WIDTH, current_panel_height(app)));
    }
}

fn current_panel_height(app: &AppHandle) -> f64 {
    let count = app
        .try_state::<AppState>()
        .map(|state| state.session_screenshots.lock().unwrap().len())
        .unwrap_or(0);
    if count == 0 {
        return clamp_panel_height(app, PANEL_HEIGHT);
    }

    let visible_count = count.min(PANEL_MAX_VISIBLE_SHOTS).max(1);
    let rows = ((visible_count + 2) / 3) as f64; // 3 per row
    clamp_panel_height(app, PANEL_FILLED_BASE_HEIGHT + (rows - 1.0).max(0.0) * PANEL_THUMBNAIL_ROW_HEIGHT)
}

fn clamp_panel_height(app: &AppHandle, height: f64) -> f64 {
    let max_height = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let scale = m.scale_factor();
            (m.size().height as f64 / scale - 40.0).max(PANEL_MIN_HEIGHT)
        })
        .unwrap_or(820.0);

    height.clamp(PANEL_MIN_HEIGHT, max_height)
}

#[tauri::command]
fn resize_panel(app: AppHandle, height: f64) {
    if let Some(panel) = app.get_webview_window("panel") {
        let next_height = clamp_panel_height(&app, height);
        let _ = panel.set_size(LogicalSize::new(PANEL_WIDTH, next_height));
    }
}

#[tauri::command]
fn show_panel(app: AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        fit_panel_window(&app);
        let _ = panel.show();
        let _ = panel.set_focus();
    } else {
        create_panel_window(&app);
    }
}

#[tauri::command]
fn hide_panel(app: AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
}


#[cfg(target_os = "macos")]
fn set_dock_icon() {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    let bytes = include_bytes!("../icons/icon.png");
    unsafe {
        let ns_data: *mut Object = msg_send![class!(NSData),
            dataWithBytes: bytes.as_ptr()
            length: bytes.len()];
        let ns_image: *mut Object = msg_send![class!(NSImage), alloc];
        let ns_image: *mut Object = msg_send![ns_image, initWithData: ns_data];
        let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![ns_app, setApplicationIconImage: ns_image];
    }
}

#[tauri::command]
fn show_gallery(app: AppHandle) {
    // Show Dock icon while gallery is open
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        set_dock_icon();
    }

    if let Some(gallery) = app.get_webview_window("gallery") {
        let (x, y) = gallery_position(&app);
        let _ = gallery.set_size(LogicalSize::new(GALLERY_WIDTH, GALLERY_HEIGHT));
        let _ = gallery.set_position(LogicalPosition::new(x, y));
        // macOS keeps native decorations (overlay title bar with traffic lights)
        #[cfg(not(target_os = "macos"))]
        let _ = gallery.set_decorations(false);
        let _ = gallery.set_resizable(true);
        #[cfg(target_os = "macos")]
        let _ = gallery.set_effects(
            EffectsBuilder::new()
                .effect(Effect::Popover)
                .state(EffectState::Active)
                .build(),
        );
        #[cfg(target_os = "windows")]
        let _ = gallery.set_effects(
            EffectsBuilder::new()
                .effect(Effect::Acrylic)
                .build(),
        );
        let _ = gallery.show();
        let _ = gallery.maximize();
        let _ = gallery.set_focus();
        let _ = app.emit("screenshots-updated", ());
    } else {
        create_gallery_window(&app);
    }
}

/// Set NSWindowStyleMaskNonactivatingPanel (bit 7) on the underlying NSWindow.
/// With this bit set, clicking the panel does NOT make it the key window —
/// mouse events are delivered directly to the content without the "activation
/// click" step. This is the same mechanism used by Spotlight, Alfred, and
/// other always-on-top floating panels.
#[cfg(target_os = "macos")]
fn apply_non_activating_style(window: &tauri::WebviewWindow) {
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};
    unsafe {
        if let Ok(ptr) = window.ns_window() {
            let ns_window = ptr as *mut Object;
            let current_mask: usize = msg_send![ns_window, styleMask];
            // NSWindowStyleMaskNonactivatingPanel = 1 << 7 = 128
            let _: () = msg_send![ns_window, setStyleMask: current_mask | 128usize];
        }
    }
}

#[tauri::command]
fn open_system_settings(section: String) {
    #[cfg(target_os = "macos")]
    {
        let url = match section.as_str() {
            "accessibility" => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            "security"      => "x-apple.systempreferences:com.apple.preference.security",
            _               => "x-apple.systempreferences:",
        };
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let url = match section.as_str() {
            "accessibility" => "ms-settings:easeofaccess",
            "security"      => "ms-settings:privacy",
            _               => "ms-settings:",
        };
        let _ = std::process::Command::new("explorer").arg(url).spawn();
    }
}

pub fn create_panel_window(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window("panel") {
        fit_panel_window(app);
        let _ = panel.show();
        return;
    }

    let panel_url = {
        #[cfg(debug_assertions)]
        { WebviewUrl::External("http://localhost:1420/panel.html".parse().unwrap()) }
        #[cfg(not(debug_assertions))]
        { WebviewUrl::App("panel.html".into()) }
    };

    let (x, y) = panel_position(app);

    let panel_builder = WebviewWindowBuilder::new(app, "panel", panel_url)
        .title("TooEasy")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .position(x, y)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .transparent(true)
        .accept_first_mouse(true)
        .shadow(true)
        .resizable(false);
    #[cfg(target_os = "macos")]
    let panel_builder = panel_builder.effects(
        EffectsBuilder::new()
            .effect(Effect::Popover)
            .state(EffectState::Active)
            .radius(30.0)
            .build(),
    );
    #[cfg(target_os = "windows")]
    let panel_builder = panel_builder.effects(
        EffectsBuilder::new()
            .effect(Effect::Acrylic)
            .build(),
    );
    match panel_builder.build()
    {
        Ok(panel_win) => {
            // Tauri's accept_first_mouse(true) patches WKWebView, but the
            // VisualEffectView wrapping it may intercept the first click first.
            // Setting NSWindowStyleMaskNonactivatingPanel (bit 7 = 128) on the
            // NSWindow prevents the OS from consuming the first click for window
            // activation, so clicks reach the button immediately.
            #[cfg(target_os = "macos")]
            apply_non_activating_style(&panel_win);
        }
        Err(e) => eprintln!("[panel] create error: {e}"),
    }
}

fn create_gallery_window(app: &AppHandle) {
    let (x, y) = gallery_position(app);
    let gallery_builder = WebviewWindowBuilder::new(
        app,
        "gallery",
        WebviewUrl::App("index.html".into()),
    )
    .title("TooEasy")
    .inner_size(GALLERY_WIDTH, GALLERY_HEIGHT)
    .position(x, y)
    .resizable(true)
    .transparent(true)
    .visible(true);
    // macOS: native title bar overlaid on our content — real traffic lights,
    // hidden title text. The webview titlebar row leaves room for the lights.
    #[cfg(target_os = "macos")]
    let gallery_builder = gallery_builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(LogicalPosition::new(20.0, 22.0))
        .effects(
            EffectsBuilder::new()
                .effect(Effect::Popover)
                .state(EffectState::Active)
                .build(),
        );
    #[cfg(not(target_os = "macos"))]
    let gallery_builder = gallery_builder.decorations(false).shadow(false);
    #[cfg(target_os = "windows")]
    let gallery_builder = gallery_builder.effects(
        EffectsBuilder::new()
            .effect(Effect::Acrylic)
            .build(),
    );
    if let Ok(window) = gallery_builder.build()
    {
        // When the user closes the gallery: hide it (don't destroy) and remove Dock icon
        let win2 = window.clone();
        let app2 = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = win2.hide();
                #[cfg(target_os = "macos")]
                let _ = app2.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(
                    "sqlite:tooeasy.db",
                    vec![tauri_plugin_sql::Migration {
                        version: 1,
                        description: "create screenshots table",
                        sql: include_str!("../migrations/001_init.sql"),
                        kind: tauri_plugin_sql::MigrationKind::Up,
                    }],
                )
                .build(),
        )
        .manage(AppState {
            last_active_app: Mutex::new(ActiveApp::default()),
            pending_image: Mutex::new(None),
            session_screenshots: Mutex::new(Vec::new()),
            is_pro: Mutex::new(license_manager::load_license().is_some()),
            suppress_watcher_until: Mutex::new(None),
        })
        .setup(|app| {
            // Hide from Dock — TooEasy lives in the menu bar tray only
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let open_i = MenuItem::with_id(app, "open", "Open TooEasy", true, Some("cmd+o"))?;
            let prefs_i = MenuItem::with_id(app, "prefs", "Preferences", true, Some("cmd+,"))?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit TooEasy", true, Some("cmd+q"))?;
            let menu = Menu::with_items(app, &[&open_i, &prefs_i, &quit_i])?;

            let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
                .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_gallery(app.clone()),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_panel(tray.app_handle().clone());
                    }
                })
                .build(app)?;

            // ── App menu bar (TooEasy + File + Edit + Help) ────────────────
            let app_menu = {
                let hide_i = PredefinedMenuItem::hide(app, Some("Hide TooEasy"))?;
                let sep    = PredefinedMenuItem::separator(app)?;
                let quit_i = PredefinedMenuItem::quit(app, Some("Quit TooEasy"))?;
                Submenu::with_id_and_items(app, "app", "TooEasy", true, &[&hide_i, &sep, &quit_i])?
            };
            let file_menu = {
                let gallery_i = MenuItem::with_id(app, "mb_gallery", "Open Gallery", true, Some("cmd+g"))?;
                let panel_i   = MenuItem::with_id(app, "mb_panel",   "Show Panel",   true, Some("cmd+p"))?;
                let sep       = PredefinedMenuItem::separator(app)?;
                let close_i   = PredefinedMenuItem::close_window(app, Some("Close Window"))?;
                let sep2      = PredefinedMenuItem::separator(app)?;
                let quit_i    = MenuItem::with_id(app, "mb_quit", "Quit TooEasy", true, Some("cmd+q"))?;
                Submenu::with_id_and_items(app, "file", "File", true, &[&gallery_i, &panel_i, &sep, &close_i, &sep2, &quit_i])?
            };
            let edit_menu = {
                let undo       = PredefinedMenuItem::undo(app, None)?;
                let redo       = PredefinedMenuItem::redo(app, None)?;
                let sep1       = PredefinedMenuItem::separator(app)?;
                let cut        = PredefinedMenuItem::cut(app, None)?;
                let copy       = PredefinedMenuItem::copy(app, None)?;
                let paste      = PredefinedMenuItem::paste(app, None)?;
                let sep2       = PredefinedMenuItem::separator(app)?;
                let select_all = PredefinedMenuItem::select_all(app, None)?;
                Submenu::with_id_and_items(app, "edit", "Edit", true, &[&undo, &redo, &sep1, &cut, &copy, &paste, &sep2, &select_all])?
            };
            let help_menu = {
                let support_i = MenuItem::with_id(app, "mb_support", "Support", true, None::<&str>)?;
                Submenu::with_id_and_items(app, "help", "Help", true, &[&support_i])?
            };
            let menu_bar = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &help_menu])?;
            app.set_menu(menu_bar)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "mb_gallery" => show_gallery(app.clone()),
                "mb_panel"   => show_panel(app.clone()),
                "mb_quit"    => app.exit(0),
                "mb_support" => {
                    #[cfg(target_os = "macos")]
                    let _ = std::process::Command::new("open").arg("mailto:ahamedmansoor1988@gmail.com").spawn();
                    #[cfg(target_os = "windows")]
                    let _ = std::process::Command::new("explorer").arg("mailto:ahamedmansoor1988@gmail.com").spawn();
                }
                _ => {}
            });
            // ────────────────────────────────────────────────────────────────

            let app_handle = app.handle().clone();
            {
                let app_handle2 = app_handle.clone();
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        let current = active_app_detector::get_frontmost_app();
                        if !current.bundle_id.contains("tooeasy")
                            && !current.name.contains("TooEasy")
                            && !current.bundle_id.is_empty()
                        {
                            let s: State<AppState> = app_handle2.state();
                            *s.last_active_app.lock().unwrap() = current;
                        }
                    }
                });
            }

            create_panel_window(app.handle());
            if let Some(panel) = app.get_webview_window("panel") {
                let _ = panel.hide();
            }

            // Attach close handler to the config-created gallery window
            if let Some(gallery) = app.get_webview_window("gallery") {
                let win2 = gallery.clone();
                let app2 = app.handle().clone();
                gallery.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win2.hide();
                        #[cfg(target_os = "macos")]
                        let _ = app2.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                });
            }

            clipboard_watcher::start(app_handle);

            // Open the gallery on every launch (first run also shows onboarding).
            show_gallery(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_last_active_app,
            get_pending_image,
            save_screenshot,
            list_screenshots,
            delete_screenshot,
            trash_screenshot,
            edit_screenshot,
            paste_to_app,
            copy_image,
            copy_selected,
            paste_selected_to_app,
            show_panel,
            resize_panel,
            hide_panel,
            show_gallery,
            add_session_screenshot,
            get_session_screenshots,
            remove_session_screenshot,
            clear_session_screenshots,
            get_is_pro,
            set_is_pro,
            activate_license,
            deactivate_license,
            paste_file_to_app,
            copy_image_file,
            ocr_image,
            ocr_data_url,
            open_system_settings,
            quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Double-clicking the app in Applications (or the Dock) while it's
            // already running re-opens the gallery instead of doing nothing.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_gallery(app.clone());
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
