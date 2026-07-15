pub fn run() -> anyhow::Result<()> {
    let report = crate::opencode_install::doctor();
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
