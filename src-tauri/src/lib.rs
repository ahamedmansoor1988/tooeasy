mod active_app_detector;
mod clipboard_watcher;
mod file_manager;
mod paste_manager;

use active_app_detector::ActiveApp;
use std::sync::Mutex;
use tauri::{
    LogicalSize,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::{Effect, EffectState, EffectsBuilder},
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};

const PANEL_WIDTH: f64 = 320.0;
const PANEL_HEIGHT: f64 = 400.0;
const PANEL_MIN_HEIGHT: f64 = PANEL_HEIGHT;
const PANEL_THUMBNAIL_ROW_HEIGHT: f64 = 92.0;

pub struct AppState {
    pub last_active_app: Mutex<ActiveApp>,
    pub pending_image: Mutex<Option<String>>,
    // All screenshots captured this session — frontend manages selection
    pub session_screenshots: Mutex<Vec<String>>,
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
fn paste_to_app(data_url: String, bundle_id: String) -> Result<(), String> {
    paste_manager::paste_to_app(&data_url, &bundle_id)
}

#[tauri::command]
fn copy_image(data_url: String) -> Result<(), String> {
    paste_manager::copy_image(&data_url)
}

#[tauri::command]
fn get_pending_image(state: State<AppState>) -> Option<String> {
    state.pending_image.lock().unwrap().clone()
}

// Session screenshot commands — called by frontend when a new clipboard event fires
#[tauri::command]
fn add_session_screenshot(state: State<AppState>, data_url: String) -> Result<usize, String> {
    let mut shots = state.session_screenshots.lock().unwrap();
    // Dedup: skip if this exact data_url is already in the session
    if shots.iter().any(|s| s == &data_url) {
        return Ok(shots.len());
    }
    if shots.len() >= 10 {
        shots.remove(0);
    }
    shots.push(data_url);
    Ok(shots.len())
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
fn paste_selected_to_app(data_urls: Vec<String>, bundle_id: String) -> Result<(), String> {
    if data_urls.is_empty() {
        return Err("No screenshots selected".into());
    }
    paste_manager::paste_images_sequential(&data_urls, &bundle_id)
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
    let rows = ((count.max(1) + 1) / 2) as f64;
    clamp_panel_height(
        app,
        PANEL_HEIGHT + (rows - 1.0).max(0.0) * PANEL_THUMBNAIL_ROW_HEIGHT,
    )
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

#[tauri::command]
fn show_gallery(app: AppHandle) {
    if let Some(gallery) = app.get_webview_window("gallery") {
        let _ = gallery.show();
        let _ = gallery.set_focus();
        let _ = app.emit("screenshots-updated", ());
    } else {
        create_gallery_window(&app);
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

    match WebviewWindowBuilder::new(app, "panel", panel_url)
        .title("TooEasy")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .position(x, y)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .transparent(true)
        .effects(
            EffectsBuilder::new()
                .effect(Effect::Popover)
                .state(EffectState::Active)
                .radius(30.0)
                .build(),
        )
        .shadow(true)
        .resizable(false)
        .build()
    {
        Ok(_) => eprintln!("[panel] created at ({x}, {y})"),
        Err(e) => eprintln!("[panel] create error: {e}"),
    }
}

fn create_gallery_window(app: &AppHandle) {
    let _ = WebviewWindowBuilder::new(
        app,
        "gallery",
        WebviewUrl::App("index.html".into()),
    )
    .title("TooEasy")
    .inner_size(1100.0, 700.0)
    .decorations(false)
    .resizable(true)
    .transparent(true)
    .effects(
        EffectsBuilder::new()
            .effect(Effect::HudWindow)
            .state(EffectState::Active)
            .radius(16.0)
            .build(),
    )
    .shadow(true)
    .build();
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
        })
        .setup(|app| {
            let open_i = MenuItem::with_id(app, "open", "Open TooEasy", true, Some("cmd+o"))?;
            let prefs_i = MenuItem::with_id(app, "prefs", "Preferences", true, Some("cmd+,"))?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit TooEasy", true, Some("cmd+q"))?;
            let menu = Menu::with_items(app, &[&open_i, &prefs_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
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

            clipboard_watcher::start(app_handle);

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
