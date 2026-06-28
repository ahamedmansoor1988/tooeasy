use base64::Engine;
use std::process::Command;
use std::time::Duration;

pub fn paste_to_app(data_url: &str, bundle_id: &str) -> Result<(), String> {
    write_png_to_pasteboard(data_url)?;

    if !bundle_id.is_empty() {
        activate_app(bundle_id);
    }

    send_cmd_v()
}

// AI tools accept multiple sequential image pastes as separate images
fn is_ai_app(bundle_id: &str) -> bool {
    let ai_prefixes = [
        "com.anthropic",    // Claude
        "com.openai",       // ChatGPT
        "com.google.Gemini",
    ];
    ai_prefixes.iter().any(|p| bundle_id.starts_with(p))
}

// Paste multiple images:
//   - AI apps (Claude, ChatGPT) → sequential Cmd+V so each image is separate
//   - Design tools (Figma, etc.) → stitch side-by-side, paste as one image
pub fn paste_images_sequential(data_urls: &[String], bundle_id: &str) -> Result<(), String> {
    if data_urls.is_empty() {
        return Ok(());
    }

    // Focus the target app once
    if !bundle_id.is_empty() {
        activate_app(bundle_id);
    }

    let is_figma = bundle_id.contains("figma");

    // For Figma: get window bounds once so we can click the X position field
    let figma_x_field: Option<(i32, i32)> = if is_figma {
        get_figma_x_field_coords()
    } else {
        None
    };

    for (i, data_url) in data_urls.iter().enumerate() {
        write_png_to_pasteboard(data_url)?;
        std::thread::sleep(Duration::from_millis(150));
        send_cmd_v()?;
        std::thread::sleep(Duration::from_millis(500));

        if is_figma {
            // Set absolute X position by clicking the X field in Figma's design panel
            // and typing the value. Each image is placed 1700px apart (wider than any screenshot).
            if let Some((fx, fy)) = figma_x_field {
                let x_pos = i as i32 * 1700;
                set_figma_x_position(fx, fy, x_pos)?;
                std::thread::sleep(Duration::from_millis(200));
            }
            // Escape to deselect before next paste so Figma pastes at viewport center
            send_escape()?;
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    Ok(())
}

// Get the screen coordinates of Figma's X position input field.
// The field is in the right design panel: 265px from window right edge, 266px from window top.
fn get_figma_x_field_coords() -> Option<(i32, i32)> {
    let output = Command::new("osascript")
        .args(["-e", r#"
tell application "System Events"
    tell process "Figma"
        set p to position of window 1
        set s to size of window 1
        return ((item 1 of p) + (item 1 of s) - 265) & "," & ((item 2 of p) + 266)
    end tell
end tell
"#])
        .output()
        .ok()?;
    let s = String::from_utf8(output.stdout).ok()?;
    let s = s.trim();
    let mut parts = s.split(',');
    let x: i32 = parts.next()?.trim().parse().ok()?;
    let y: i32 = parts.next()?.trim().parse().ok()?;
    Some((x, y))
}

// Click Figma's X position field and type an absolute X value, then press Return
fn set_figma_x_position(field_x: i32, field_y: i32, x_pos: i32) -> Result<(), String> {
    let script = format!(
        r#"
tell application "System Events"
    tell process "Figma"
        set frontmost to true
        click at {{{field_x}, {field_y}}}
        delay 0.15
        keystroke "a" using command down
        keystroke "{x_pos}"
        key code 36
    end tell
end tell
"#
    );
    Command::new("osascript")
        .args(["-e", &script])
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn activate_app(bundle_id: &str) {
    let _ = Command::new("open").args(["-b", bundle_id]).status();
    std::thread::sleep(Duration::from_millis(300));
}

fn send_escape() -> Result<(), String> {
    Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to key code 53"])
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn send_cmd_v() -> Result<(), String> {
    let status = Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to keystroke \"v\" using command down"])
        .status()
        .map_err(|e| e.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err("Could not paste. macOS may need Accessibility permission for TooEasy.".to_string())
    }
}

pub fn copy_image(data_url: &str) -> Result<(), String> {
    write_png_to_pasteboard(data_url)
}

pub fn stitch_to_data_url(data_urls: &[String]) -> Result<String, String> {
    if data_urls.len() == 1 {
        return Ok(data_urls[0].clone());
    }
    let images: Vec<image::DynamicImage> = data_urls
        .iter()
        .map(|url| {
            let bytes = png_bytes_from_data_url(url)?;
            image::load_from_memory(&bytes).map_err(|e| e.to_string())
        })
        .collect::<Result<_, _>>()?;

    let max_w = images.iter().map(|i| i.width()).max().unwrap_or(0);
    let total_h = images.iter().map(|i| i.height()).sum();
    let mut canvas = image::RgbaImage::new(max_w, total_h);
    let mut y_offset = 0u32;
    for img in &images {
        let rgba = img.to_rgba8();
        for (x, y, pixel) in rgba.enumerate_pixels() {
            canvas.put_pixel(x, y + y_offset, *pixel);
        }
        y_offset += img.height();
    }
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    Ok(format!("data:image/png;base64,{b64}"))
}

pub fn copy_images_stitched(data_urls: &[String]) -> Result<(), String> {
    let stitched = stitch_to_data_url(data_urls)?;
    write_png_to_pasteboard(&stitched)
}

fn png_bytes_from_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let base64_data = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or("Invalid PNG data URL")?;

    base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn write_png_to_pasteboard(data_url: &str) -> Result<(), String> {
    use objc::{class, msg_send, sel, sel_impl};

    let bytes = png_bytes_from_data_url(data_url)?;

    unsafe {
        let pasteboard: *mut objc::runtime::Object =
            msg_send![class!(NSPasteboard), generalPasteboard];
        let _: isize = msg_send![pasteboard, clearContents];

        let data: *mut objc::runtime::Object = msg_send![class!(NSData), dataWithBytes:bytes.as_ptr() length:bytes.len()];
        if data == cocoa::base::nil {
            return Err("Could not create PNG pasteboard data".to_string());
        }

        let png_type = make_nsstring("public.png");
        let success: bool = msg_send![pasteboard, setData:data forType:png_type];
        if success {
            Ok(())
        } else {
            Err("Could not write image to macOS pasteboard".to_string())
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn write_png_to_pasteboard(_data_url: &str) -> Result<(), String> {
    Err("Pasting to apps is only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
unsafe fn make_nsstring(s: &str) -> *mut objc::runtime::Object {
    use objc::{class, msg_send, sel, sel_impl};

    let ns: *mut objc::runtime::Object = msg_send![class!(NSString), alloc];
    let bytes = s.as_ptr() as *const std::os::raw::c_void;
    msg_send![ns, initWithBytes:bytes length:s.len() encoding:4u64]
}
