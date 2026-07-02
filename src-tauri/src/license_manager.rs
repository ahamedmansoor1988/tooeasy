use std::path::PathBuf;

// Set this to your Gumroad product permalink once you publish.
// Leave empty during development — any non-empty key will be accepted.
const GUMROAD_PRODUCT_PERMALINK: &str = "bkbxux";

fn license_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join("Library/Application Support/TooEasy/license.key")
}

pub fn load_license() -> Option<String> {
    std::fs::read_to_string(license_path())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn save_license(key: &str) -> Result<(), String> {
    let path = license_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, key.trim()).map_err(|e| e.to_string())
}

pub fn remove_license() -> Result<(), String> {
    let path = license_path();
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Validate a key against Gumroad. Returns Ok(true) if valid.
/// During development (empty permalink), accepts any non-empty key.
const DEVELOPER_KEY: &str = "TOOEASY-DEV-MANSOOR-2026";

pub fn verify_key(key: &str) -> Result<bool, String> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(false);
    }

    // Developer's own key — always valid, no network call
    if key == DEVELOPER_KEY {
        return Ok(true);
    }

    if GUMROAD_PRODUCT_PERMALINK.is_empty() {
        // Dev mode: accept any non-empty key
        return Ok(true);
    }

    let post_data = format!(
        "product_permalink={}&license_key={}",
        GUMROAD_PRODUCT_PERMALINK,
        url_encode(key)
    );

    let output = std::process::Command::new("curl")
        .args([
            "-s", "--max-time", "10",
            "-X", "POST",
            "https://api.gumroad.com/v2/licenses/verify",
            "-H", "Content-Type: application/x-www-form-urlencoded",
            "-d", &post_data,
        ])
        .output()
        .map_err(|e| format!("Network error: {e}"))?;

    if !output.status.success() {
        return Err("Could not reach Gumroad. Check your internet connection.".to_string());
    }

    let body = String::from_utf8_lossy(&output.stdout);
    // Gumroad returns {"success":true,...} or {"success":false,...}
    if body.contains("\"success\":true") || body.contains("\"success\": true") {
        Ok(true)
    } else if body.contains("\"success\":false") || body.contains("\"success\": false") {
        Ok(false)
    } else {
        Err(format!("Unexpected response from Gumroad: {body}"))
    }
}

fn url_encode(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || "-._~".contains(c) {
                vec![c]
            } else {
                format!("%{:02X}", c as u32).chars().collect()
            }
        })
        .collect()
}
