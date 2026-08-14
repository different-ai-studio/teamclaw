pub fn run() -> anyhow::Result<()> {
    let mut report = crate::opencode_install::doctor();

    // Every runtime, every time — not just the configured one.
    //
    // This used to fill in exactly one of pi/cursor/claude, chosen by
    // `AMUXD_DOCTOR_LOCAL_AGENT` or `agents.local_agent`, so a caller could only
    // ever learn about the runtime it already had. The desktop setup wizard
    // needs the opposite: which runtimes are on this machine, so it can offer
    // the ones that are (cursor and claude-code cannot be installed by the app,
    // so "already there" is the only way they can ever be offered).
    //
    // Consumers read these by key name rather than treating presence as a
    // signal, so always populating them is additive.
    //
    // Run concurrently: pi and claude each shell out to `--version`, and the
    // desktop already pays ~4s for this command on a cold first launch. Three
    // sequential probes would add both spawns to that; scoped threads make the
    // cost the slowest one rather than their sum.
    let (pi, cursor, claude) = std::thread::scope(|s| {
        let pi = s.spawn(crate::pi_install::doctor);
        let cursor = s.spawn(crate::cursor_install::doctor);
        let claude = s.spawn(crate::claude_install::doctor);
        // A panicking probe must not take the whole report down with it: the
        // caller still needs opencode/amuxd status to render anything.
        (pi.join().ok(), cursor.join().ok(), claude.join().ok())
    });
    report.pi = pi;
    report.cursor = cursor;
    report.claude = claude;

    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
