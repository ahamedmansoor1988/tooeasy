use base64::Engine;
use chrono::Local;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

pub struct SavedScreenshot {
    pub filepath: String,
    pub filename: String,
}

#[derive(serde::Serialize)]
pub struct ScreenshotItem {
    pub filepath: String,
    pub filename: String,
    pub data_url: String,
    pub captured_at: String,
}

pub fn save_screenshot(data_url: &str, app_name: &str) -> Result<SavedScreenshot, String> {
    let base64_data = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or("Invalid data URL")?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| e.to_string())?;

    let now = Local::now();
    let dir = home_dir()
        .join("TooEasy")
        .join(now.format("%Y").to_string())
        .join(now.format("%m").to_string())
        .join(now.format("%d").to_string());

    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let safe_app = app_name
        .to_lowercase()
        .replace(' ', "_")
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .collect::<String>();
    let safe_app = if safe_app.is_empty() {
        "unknown".to_string()
    } else {
        safe_app
    };

    let filename = format!("screenshot_{}{:03}_{}.png", now.format("%H%M%S"), now.timestamp_subsec_millis(), safe_app);
    let filepath = dir.join(&filename);

    fs::write(&filepath, &bytes).map_err(|e| e.to_string())?;

    Ok(SavedScreenshot {
        filepath: filepath.to_string_lossy().into_owned(),
        filename,
    })
}

pub fn list_screenshots() -> Result<Vec<ScreenshotItem>, String> {
    let root = home_dir().join("TooEasy");
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    collect_png_files(&root, &mut files)?;

    files.sort_by(|a, b| b.1.cmp(&a.1));
    files
        .into_iter()
        .take(100)
        .map(|(path, modified)| {
            let captured_at = chrono::DateTime::<Local>::from(modified)
                .format("%b %-d, %Y %-I:%M %p")
                .to_string();

            Ok(ScreenshotItem {
                filename: path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "screenshot.png".to_string()),
                filepath: path.to_string_lossy().into_owned(),
                // Do NOT pre-load image bytes — gallery uses convertFileSrc(filepath)
                // so the browser loads images directly from disk via asset:// protocol.
                data_url: String::new(),
                captured_at,
            })
        })
        .collect()
}

// Read a single screenshot file and return its base64 data URL.
// Used when the actual image bytes are needed (paste, copy to clipboard).
pub fn read_screenshot_data_url(filepath: &str) -> Result<String, String> {
    let path = validated_screenshot_path(filepath)?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

pub fn delete_screenshot(filepath: &str) -> Result<(), String> {
    let path = validated_screenshot_path(filepath)?;
    fs::remove_file(path).map_err(|e| e.to_string())
}

pub fn trash_screenshot(filepath: &str) -> Result<(), String> {
    let path = validated_screenshot_path(filepath)?;
    trash::delete(path).map_err(|e| e.to_string())
}

pub fn edit_screenshot(filepath: &str) -> Result<(), String> {
    let path = validated_screenshot_path(filepath)?;
    Command::new("open")
        .arg(path)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn validated_screenshot_path(filepath: &str) -> Result<PathBuf, String> {
    let root = home_dir().join("TooEasy");
    let path = PathBuf::from(filepath);
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical_path = path.canonicalize().map_err(|e| e.to_string())?;

    if !canonical_path.starts_with(canonical_root) {
        return Err("Screenshot is outside the TooEasy folder".to_string());
    }

    if !canonical_path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
    {
        return Err("Only PNG screenshots can be edited or deleted".to_string());
    }

    Ok(canonical_path)
}

fn collect_png_files(dir: &PathBuf, files: &mut Vec<(PathBuf, std::time::SystemTime)>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let metadata = entry.metadata().map_err(|e| e.to_string())?;

        if metadata.is_dir() {
            collect_png_files(&path, files)?;
        } else if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("png")) {
            let modified = metadata.modified().map_err(|e| e.to_string())?;
            files.push((path, modified));
        }
    }

    Ok(())
}

fn home_dir() -> PathBuf {
    dirs_sys_home().unwrap_or_else(|| PathBuf::from("/tmp"))
}

#[cfg(target_os = "macos")]
fn dirs_sys_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(not(target_os = "macos"))]
fn dirs_sys_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}
