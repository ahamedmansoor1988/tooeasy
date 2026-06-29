fn main() {
    tauri_build::build();
    // Link macOS Vision framework for native OCR
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-lib=framework=Vision");
}
