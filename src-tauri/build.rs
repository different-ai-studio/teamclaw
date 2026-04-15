/// Deep-merge two JSON values (objects are merged recursively, everything else is overwritten).
fn deep_merge(base: &mut serde_json::Value, overlay: serde_json::Value) {
    if let (serde_json::Value::Object(base_map), serde_json::Value::Object(overlay_map)) =
        (base, overlay)
    {
        for (key, overlay_val) in overlay_map {
            let entry = base_map.entry(key).or_insert(serde_json::Value::Null);
            if entry.is_object() && overlay_val.is_object() {
                deep_merge(entry, overlay_val);
            } else {
                *entry = overlay_val;
            }
        }
    }
}

fn main() {
    // ── Read build config: base → env → local (mirrors vite.config.ts) ──
    let root_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();

    let base_path = root_dir.join("build.config.json");
    println!("cargo:rerun-if-changed={}", base_path.display());

    let mut config: serde_json::Value = std::fs::read_to_string(&base_path)
        .map(|s| serde_json::from_str(&s).expect("build.config.json is not valid JSON"))
        .unwrap_or_else(|_| serde_json::json!({"app":{"name":"TeamClaw"}}));

    // Merge build.config.{BUILD_ENV}.json if BUILD_ENV is set
    if let Ok(build_env) = std::env::var("BUILD_ENV") {
        let env_path = root_dir.join(format!("build.config.{}.json", build_env));
        println!("cargo:rerun-if-changed={}", env_path.display());
        if let Ok(s) = std::fs::read_to_string(&env_path) {
            let env_config: serde_json::Value = serde_json::from_str(&s)
                .unwrap_or_else(|_| panic!("build.config.{}.json is not valid JSON", build_env));
            deep_merge(&mut config, env_config);
        }
    }

    // Merge build.config.local.json
    let local_path = root_dir.join("build.config.local.json");
    println!("cargo:rerun-if-changed={}", local_path.display());
    if let Ok(s) = std::fs::read_to_string(&local_path) {
        let local_config: serde_json::Value =
            serde_json::from_str(&s).expect("build.config.local.json is not valid JSON");
        deep_merge(&mut config, local_config);
    }

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

    // Export updater config from build.config.json
    if let Some(endpoint) = config["app"]["updater"]["endpoint"].as_str() {
        println!("cargo:rustc-env=UPDATER_ENDPOINT={}", endpoint);
        println!("cargo:warning=Using UPDATER_ENDPOINT={}", endpoint);
    }
    if let Some(pubkey) = config["app"]["updater"]["pubkey"].as_str() {
        println!("cargo:rustc-env=UPDATER_PUBKEY={}", pubkey);
        println!("cargo:warning=Using UPDATER_PUBKEY={}", pubkey);
    }

    // Export device JWT secret for HS256 token generation.
    let device_jwt_secret = config["device"]["jwtSecret"].as_str().unwrap_or("");
    println!("cargo:rustc-env=DEVICE_JWT_SECRET={}", device_jwt_secret);
    if device_jwt_secret.is_empty() {
        println!("cargo:warning=device.jwtSecret is not set — device token generation will fail at runtime");
    }

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

    // Check that the teamclaw-introspect sidecar binary exists.
    // Unlike opencode (downloaded), this is built from crates/teamclaw-introspect.
    // rust-cli.js auto-builds it before invoking cargo.
    let introspect_bin = format!("binaries/teamclaw-introspect-{}", target_triple);
    let introspect_bin_exe = format!("{}.exe", introspect_bin);
    let introspect_exists = std::path::Path::new(&introspect_bin).exists()
        || (target_triple.contains("windows")
            && std::path::Path::new(&introspect_bin_exe).exists());
    if !introspect_exists && !in_ci {
        panic!(
            "\n\n\
            ╔══════════════════════════════════════════════════════════════╗\n\
            ║  teamclaw-introspect sidecar binary not found!             ║\n\
            ║                                                            ║\n\
            ║  Build it with:                                            ║\n\
            ║    cargo build -p teamclaw-introspect                      ║\n\
            ║    cp target/debug/teamclaw-introspect {:<20}║\n\
            ╚══════════════════════════════════════════════════════════════╝\n\n",
            introspect_bin
        );
    }
    println!("cargo:rerun-if-changed={}", introspect_bin);

    tauri_build::build()
}
