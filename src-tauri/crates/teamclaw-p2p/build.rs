fn main() {
    // Read APP_SHORT_NAME from the same build.config.json used by the main crate.
    // This ensures the iroh storage directory matches across crates.
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    // crates/teamclaw-p2p -> src-tauri -> project root
    let root_dir = manifest_dir.parent().unwrap().parent().unwrap().parent().unwrap();

    let base_path = root_dir.join("build.config.json");
    println!("cargo:rerun-if-changed={}", base_path.display());

    let config: serde_json::Value = std::fs::read_to_string(&base_path)
        .map(|s| serde_json::from_str(&s).expect("build.config.json is not valid JSON"))
        .unwrap_or_else(|_| serde_json::json!({"app":{"name":"TeamClaw"}}));

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

    println!("cargo:rustc-env=APP_SHORT_NAME={}", short_name);
}
