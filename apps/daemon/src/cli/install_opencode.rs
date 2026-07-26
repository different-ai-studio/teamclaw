pub fn run(force: bool) -> anyhow::Result<()> {
    crate::opencode_install::run_install(force)
}

/// Print `{installed, latest, upToDate}` for the settings Dependencies UI.
///
/// `latest` comes from the mirror manifest and is null when the mirror can't be
/// reached — we do NOT fall back to asking GitHub, because that is exactly the
/// network this exists to avoid. A null `latest` means "unknown", and the UI
/// should keep offering the update rather than claiming either state.
pub fn print_versions() {
    let installed = crate::opencode_install::detect_opencode().map(|(_, v)| v);
    let latest = crate::opencode_install::mirror_latest_version();
    let up_to_date = match (installed.as_deref(), latest.as_deref()) {
        // `>=`, not `==`: a user on a build newer than the mirror's daily sync
        // is up to date, not out of date.
        (Some(have), Some(want)) => Some(crate::opencode_install::version_ge(have, want)),
        _ => None,
    };
    println!(
        "{}",
        serde_json::json!({
            "installed": installed,
            "latest": latest,
            "upToDate": up_to_date,
        })
    );
}
