/// Register all optional plugins.
/// Plugins are enabled via Cargo feature flags.
/// To enable the team plugin: cargo build --features team
pub fn register_all(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    #[cfg(feature = "team")]
    let builder = builder.plugin(tauri_plugin_team::init());
    builder
}
