pub fn install() -> anyhow::Result<()> {
    crate::service::install_service()?;
    println!("amuxd service installed and started");
    Ok(())
}

pub fn uninstall() -> anyhow::Result<()> {
    crate::service::uninstall_service()?;
    println!("amuxd service removed");
    Ok(())
}
