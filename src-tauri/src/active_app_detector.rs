#[derive(Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct ActiveApp {
    pub bundle_id: String,
    pub name: String,
}

#[cfg(target_os = "macos")]
pub fn get_frontmost_app() -> ActiveApp {
    use cocoa::base::nil;
    use cocoa::foundation::NSString;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: *mut Object = msg_send![workspace, frontmostApplication];
        if app == nil {
            return ActiveApp::default();
        }

        let bundle_id_ns: *mut Object = msg_send![app, bundleIdentifier];
        let name_ns: *mut Object = msg_send![app, localizedName];

        let bundle_id = if bundle_id_ns != nil {
            let ptr = NSString::UTF8String(bundle_id_ns);
            std::ffi::CStr::from_ptr(ptr)
                .to_string_lossy()
                .into_owned()
        } else {
            String::new()
        };

        let name = if name_ns != nil {
            let ptr = NSString::UTF8String(name_ns);
            std::ffi::CStr::from_ptr(ptr)
                .to_string_lossy()
                .into_owned()
        } else {
            String::new()
        };

        ActiveApp { bundle_id, name }
    }
}

#[cfg(target_os = "windows")]
pub fn get_frontmost_app() -> ActiveApp {
    use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if let Ok(handle) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) {
            let mut buf = [0u16; 260];
            let len = GetModuleFileNameExW(handle, None, &mut buf);
            if len > 0 {
                let path = String::from_utf16_lossy(&buf[..len as usize]);
                let name = std::path::Path::new(&path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let bundle_id = name.to_lowercase();
                return ActiveApp { bundle_id, name };
            }
        }
        ActiveApp::default()
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn get_frontmost_app() -> ActiveApp {
    ActiveApp::default()
}
