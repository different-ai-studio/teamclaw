pub fn run() -> anyhow::Result<()> {
    let mut report = crate::opencode_install::doctor();
    // Surface pi runtime status when the daemon is configured to use it
    // (agents.local_agent = "pi"); opencode status stays primary otherwise so
    // the setup wizard shows whichever runtime is actually configured.
    let local_agent =
        crate::config::DaemonConfig::load(&crate::config::DaemonConfig::default_path())
            .map(|c| c.agents.local_agent)
            .unwrap_or_default();
    if local_agent == "pi" {
        report.pi = Some(crate::pi_install::doctor());
    }
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
