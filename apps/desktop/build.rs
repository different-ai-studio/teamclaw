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

fn resolve_updater_url(url: &str) -> Option<String> {
    if url.contains("__OSS_BASE_URL__") {
        let oss_base = std::env::var("OSS_BASE_URL")
            .ok()
            .map(|s| s.trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())?;
        Some(url.replace("__OSS_BASE_URL__", &oss_base))
    } else if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

fn resolve_updater_endpoints(config: &serde_json::Value) -> Vec<String> {
    let updater = &config["app"]["updater"];
    let mut endpoints = Vec::new();

    let mut push_unique = |url: String| {
        if !endpoints.iter().any(|existing| existing == &url) {
            endpoints.push(url);
        }
    };

    if let Some(endpoint) = updater["endpoint"].as_str().and_then(resolve_updater_url) {
        push_unique(endpoint);
    }

    if let Some(list) = updater["endpoints"].as_array() {
        for endpoint in list.iter().filter_map(|endpoint| endpoint.as_str()) {
            if let Some(url) = resolve_updater_url(endpoint) {
                push_unique(url);
            }
        }
    }

    endpoints
}

fn main() {
    // ── Read build config: base → env → local (mirrors vite.config.ts) ──
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("Cargo must set CARGO_MANIFEST_DIR for build scripts");
    let root_dir = std::path::Path::new(&manifest_dir)
        .parent()
        .and_then(|p| p.parent())
        .unwrap();

    let base_path = root_dir.join("build.config.json");
    println!("cargo:rerun-if-changed={}", base_path.display());

    let mut config: serde_json::Value = std::fs::read_to_string(&base_path)
        .map(|s| serde_json::from_str(&s).expect("build.config.json is not valid JSON"))
        .unwrap_or_else(|_| serde_json::json!({"app":{"name":"TeamClaw"}}));

    // Merge build.config.{BUILD_ENV}.json if BUILD_ENV is set.
    // BUILD_ENV selects which config is merged (and thus the baked CLOUD_API_URL),
    // so cargo MUST re-run this script when it changes. Without this, a binary
    // first compiled without BUILD_ENV (or with a different one) keeps its stale
    // CLOUD_API_URL on a rebuild with BUILD_ENV=dev — the frontend (rebuilt by
    // vite every time) points at the dev backend while the Rust team-share / OSS
    // commands still fall back to https://cloud.ucar.cc, yielding
    // "function 'teamclaw-sync' does not exist" (FunctionNotFound) on dev.
    println!("cargo:rerun-if-env-changed=BUILD_ENV");
    if let Ok(build_env) = std::env::var("BUILD_ENV") {
        let env_path = root_dir.join(format!("build.config.{}.json", build_env));
        println!("cargo:rerun-if-changed={}", env_path.display());
        if let Ok(s) = std::fs::read_to_string(&env_path) {
            let env_config: serde_json::Value = serde_json::from_str(&s)
                .unwrap_or_else(|_| panic!("build.config.{}.json is not valid JSON", build_env));
            deep_merge(&mut config, env_config);
        }
    }

    // NOTE: build.config.local.json is intentionally NOT merged here. The vite
    // frontend dropped it from its merge chain (commit f56d0ea9) so BUILD_ENV is
    // the single authoritative way to switch environments. build.rs must mirror
    // that, otherwise a stale local override (e.g. a dead belayo-test-api pin)
    // gets baked into CLOUD_API_URL for the Rust team-share / OSS commands while
    // the frontend points at the BUILD_ENV backend — the two desync and enabling
    // Team Shared fails with "function 'belayo-test-api' does not exist".

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

    // Export updater config from build.config.json (comma-separated for runtime fallback)
    let updater_endpoints = resolve_updater_endpoints(&config);
    if !updater_endpoints.is_empty() {
        let joined = updater_endpoints.join(",");
        println!("cargo:rustc-env=UPDATER_ENDPOINTS={}", joined);
        println!("cargo:warning=Using UPDATER_ENDPOINTS={}", joined);
    }
    if let Some(pubkey) = config["app"]["updater"]["pubkey"].as_str() {
        println!("cargo:rustc-env=UPDATER_PUBKEY={}", pubkey);
        println!("cargo:warning=Using UPDATER_PUBKEY={}", pubkey);
    }

    // Bake the partner admin console host allowlist (features.auth.webSSOHosts)
    // into the binary. This is the native-side re-check that gates injecting the
    // TeamClaw bearer token into a webview, so it must come from the build config
    // rather than the renderer. Deployment-specific hostnames belong in the
    // brand's gitignored build.config.<brand>.json; absent means injection is off.
    let websso_hosts: Vec<String> = config["features"]["auth"]["webSSOHosts"]
        .as_array()
        .map(|hosts| {
            hosts
                .iter()
                .filter_map(|h| h.as_str())
                .map(str::trim)
                .filter(|h| !h.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if !websso_hosts.is_empty() {
        let joined = websso_hosts.join(",");
        println!("cargo:rustc-env=WEBSSO_ADMIN_HOSTS={}", joined);
        println!("cargo:warning=Using WEBSSO_ADMIN_HOSTS={}", joined);
    }

    // Bake the Cloud API URL into the binary so the Rust team-share / OSS
    // commands default to the SAME backend the frontend resolves from
    // (`getEffectiveServerConfigSync().cloudApiUrl`). Precedence mirrors the
    // frontend: `VITE_CLOUD_API_URL` env override wins, else `cloudApiUrl` from
    // the merged build config. Without this the Rust fallback was hardcoded to
    // the production URL, so a non-production build (e.g. belayo-test) sent its
    // freshly-issued JWT to production FC and PostgREST rejected the signature.
    println!("cargo:rerun-if-env-changed=VITE_CLOUD_API_URL");
    let cloud_api_url = std::env::var("VITE_CLOUD_API_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            config["cloudApiUrl"]
                .as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    if let Some(url) = cloud_api_url {
        let url = url.trim_end_matches('/');
        println!("cargo:rustc-env=CLOUD_API_URL={}", url);
        println!("cargo:warning=Using CLOUD_API_URL={}", url);
    }

    let target_triple = std::env::var("TARGET").unwrap_or_default();
    let in_ci = std::env::var("CI").is_ok();

    // OpenCode sidecar is optional — agent runtime is owned by amuxd. Keep the
    // binary around only for legacy local debugging; desktop builds must not
    // require downloading the >100MB sidecar.
    let binary_name = format!("binaries/opencode-{}", target_triple);
    let with_exe = format!("{}.exe", binary_name);
    let opencode_sidecar_exists = std::path::Path::new(&binary_name).exists()
        || (target_triple.contains("windows") && std::path::Path::new(&with_exe).exists());
    if opencode_sidecar_exists {
        println!("cargo:rerun-if-changed={}", binary_name);
    } else if !in_ci {
        println!(
            "cargo:warning=OpenCode sidecar not found (optional). Agent runtime is provided by amuxd."
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

    // amuxd sidecar is bundled (built by scripts/ensure-amuxd-sidecar.js before cargo).
    let amuxd_bin = format!("binaries/amuxd-{}", target_triple);
    let amuxd_bin_exe = format!("{}.exe", amuxd_bin);
    let amuxd_exists = std::path::Path::new(&amuxd_bin).exists()
        || (target_triple.contains("windows") && std::path::Path::new(&amuxd_bin_exe).exists());
    if !amuxd_exists && !in_ci {
        panic!(
            "\n\namuxd sidecar binary not found: {}\nBuild it with: node -e \"require('./scripts/ensure-amuxd-sidecar').ensureAmuxdSidecar(process.env)\"\n\n",
            amuxd_bin
        );
    }
    println!("cargo:rerun-if-changed={}", amuxd_bin);

    tauri_build::build()
}
