pub fn run() -> anyhow::Result<()> {
    let mut report = crate::opencode_install::doctor();
    // Surface pi runtime status when the daemon is configured to use it
    // (agents.local_agent = "pi"); opencode status stays primary otherwise so
    // the setup wizard shows whichever runtime is actually configured.
    //
    // `AMUXD_DOCTOR_LOCAL_AGENT` overrides the on-disk config so the desktop
    // setup wizard can reflect the *build's* target agent (buildConfig.localAgent)
    // even before daemon.toml is written — it passes the build value through and
    // gets pi status back regardless of the current daemon config.
    let local_agent = std::env::var("AMUXD_DOCTOR_LOCAL_AGENT")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            crate::config::DaemonConfig::load(&crate::config::DaemonConfig::default_path())
                .map(|c| c.agents.local_agent)
                .unwrap_or_default()
        });
    if local_agent == "pi" {
        report.pi = Some(crate::pi_install::doctor());
    }
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
