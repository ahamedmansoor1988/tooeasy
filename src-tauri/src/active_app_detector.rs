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

#[cfg(not(target_os = "macos"))]
pub fn get_frontmost_app() -> ActiveApp {
    ActiveApp::default()
}
