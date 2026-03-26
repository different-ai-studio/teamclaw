fn main() {
    // ── Read build.config.json and emit APP_SHORT_NAME ──
    let config_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("build.config.json");
    println!("cargo:rerun-if-changed={}", config_path.display());

    let config_str = std::fs::read_to_string(&config_path)
        .unwrap_or_else(|_| r#"{"app":{"name":"TeamClaw"}}"#.to_string());
    let config: serde_json::Value =
        serde_json::from_str(&config_str).expect("build.config.json is not valid JSON");

    let short_name = config["app"]["shortName"]
        .as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let name = config["app"]["name"].as_str().unwrap_or("teamclaw");
            name.chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .map(|c| c.to_ascii_lowercase())
                .collect()
        });

    // Validate
    assert!(
        !short_name.is_empty()
            && short_name.len() <= 20
            && short_name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
        "app.shortName must be 1-20 chars, [a-z0-9] only, got: '{}'",
        short_name
    );

    println!("cargo:rustc-env=APP_SHORT_NAME={}", short_name);
    println!("cargo:warning=Using APP_SHORT_NAME={}", short_name);

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
