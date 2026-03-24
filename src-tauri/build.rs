fn main() {
    // Check that the OpenCode sidecar binary exists before building.
    // The binary is not checked into git (>100MB). Developers must download it:
    //   Unix: ./src-tauri/binaries/download-opencode.sh
    //   Windows: .\src-tauri\binaries\download-opencode.ps1
    let target_triple = std::env::var("TARGET").unwrap_or_default();
    let binary_name = format!("binaries/opencode-{}", target_triple);
    let with_exe = format!("{}.exe", binary_name);
    let exists = std::path::Path::new(&binary_name).exists()
        || (target_triple.contains("windows") && std::path::Path::new(&with_exe).exists());
    let in_ci = std::env::var("CI").is_ok();
    if !exists && !in_ci {
        let hint = if target_triple.contains("windows") {
            ".\\src-tauri\\binaries\\download-opencode.ps1"
        } else {
            "./src-tauri/binaries/download-opencode.sh"
        };
        panic!(
            "\n\n\
            ╔══════════════════════════════════════════════════════════════╗\n\
            ║  OpenCode sidecar binary not found!                        ║\n\
            ║                                                            ║\n\
            ║  Run this to download it:                                  ║\n\
            ║    {:<56} ║\n\
            ╚══════════════════════════════════════════════════════════════╝\n\n",
            hint
        );
    }

    tauri_build::build()
}
