use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct DaemonInstallStatus {
    pub installed: bool,
    pub running: bool,
    pub version: Option<String>,
}

#[tauri::command]
pub async fn install_local_daemon(_supabase_jwt: String) -> Result<DaemonInstallStatus, String> {
    Err("not_implemented".into())
}

#[tauri::command]
pub async fn daemon_status() -> Result<DaemonInstallStatus, String> {
    Ok(DaemonInstallStatus {
        installed: false,
        running: false,
        version: None,
    })
}

#[tauri::command]
pub async fn uninstall_local_daemon() -> Result<(), String> {
    Err("not_implemented".into())
}
