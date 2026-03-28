/// Register all optional plugins.
/// Open-source version: no plugins.
/// Pro version overrides this file to register team plugin.

#[cfg(feature = "team")]
#[path = "../../../plugins/team/src-tauri"]
pub mod team_impl {
    // Re-export constants from crate::commands so team modules can use super::TEAMCLAW_DIR etc.
    pub use crate::commands::{CONFIG_FILE_NAME, TEAMCLAW_DIR, TEAM_REPO_DIR};

    pub mod team;
    pub mod team_unified;
    #[cfg(feature = "p2p")]
    pub mod team_p2p;
    pub mod team_webdav;
    pub mod oss_commands;
    pub mod oss_sync;
    pub mod oss_types;
    pub mod p2p_state;
    pub mod version_commands;
    pub mod version_store;
    pub mod version_types;
}

pub fn register_all(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    #[cfg(feature = "team")]
    let builder = builder.plugin(build_team_plugin());
    builder
}

#[cfg(feature = "team")]
fn build_team_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri::Manager;
    use team_impl::*;

    let mut plugin = tauri::plugin::Builder::<tauri::Wry, ()>::new("team")
        .invoke_handler(tauri::generate_handler![
            // Team core
            team::get_team_status,
            team::team_check_git_installed,
            team::team_check_workspace_has_git,
            team::team_init_repo,
            team::team_generate_gitignore,
            team::team_sync_repo,
            team::team_disconnect_repo,
            team::get_team_config,
            team::save_team_config,
            team::clear_team_config,
            // P2P
            #[cfg(feature = "p2p")]
            team_p2p::get_device_node_id,
            #[cfg(feature = "p2p")]
            team_p2p::get_device_info,
            #[cfg(feature = "p2p")]
            team_p2p::team_add_member,
            #[cfg(feature = "p2p")]
            team_p2p::team_remove_member,
            #[cfg(feature = "p2p")]
            team_p2p::team_update_member_role,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_check_team_dir,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_create_team,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_publish_drive,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_join_drive,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_disconnect_source,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_leave_team,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_dissolve_team,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_reconnect,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_rotate_ticket,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_sync_status,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_get_files_sync_status,
            #[cfg(feature = "p2p")]
            team_p2p::get_p2p_config,
            #[cfg(feature = "p2p")]
            team_p2p::save_p2p_config,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_skills_leaderboard,
            #[cfg(feature = "p2p")]
            team_p2p::p2p_save_seed_config,
            // OSS
            oss_commands::oss_create_team,
            oss_commands::oss_join_team,
            oss_commands::oss_restore_sync,
            oss_commands::oss_leave_team,
            oss_commands::oss_sync_now,
            oss_commands::oss_get_sync_status,
            oss_commands::oss_get_files_sync_status,
            oss_commands::oss_create_snapshot,
            oss_commands::oss_cleanup_updates,
            oss_commands::oss_update_members,
            oss_commands::oss_reset_team_secret,
            oss_commands::oss_get_team_config,
            oss_commands::oss_apply_team,
            oss_commands::oss_get_pending_application,
            oss_commands::oss_cancel_application,
            oss_commands::oss_approve_application,
            // Version history
            version_commands::team_list_file_versions,
            version_commands::team_list_all_versioned_files,
            version_commands::team_restore_file_version,
            // WebDAV
            team_webdav::webdav_connect,
            team_webdav::webdav_sync,
            team_webdav::webdav_disconnect,
            team_webdav::webdav_export_config,
            team_webdav::webdav_import_config,
            team_webdav::webdav_get_status,
            team_webdav::get_team_mode,
            // Unified
            team_unified::unified_team_get_members,
            team_unified::unified_team_add_member,
            team_unified::unified_team_remove_member,
            team_unified::unified_team_update_member_role,
            team_unified::unified_team_get_my_role,
            // Telemetry (team-specific)
            crate::telemetry::commands::telemetry_export_team_feedback,
            crate::telemetry::commands::telemetry_get_team_feedback_summary,
            crate::telemetry::commands::telemetry_export_leaderboard,
            crate::telemetry::commands::telemetry_get_team_leaderboard,
            crate::telemetry::commands::telemetry_get_member_aggregated_stats,
        ]);

    // Managed state for team modules
    plugin = plugin.setup(|app, _api| {
        app.manage(<p2p_state::IrohState>::default());
        app.manage(tokio::sync::Mutex::new(
            team_webdav::WebDavManagedState::default(),
        ));
        app.manage(oss_sync::OssSyncState::default());
        app.manage(version_commands::VersionStoreState::default());

        // Initialize iroh P2P node in background (non-blocking)
        #[cfg(feature = "p2p")]
        {
            let iroh_state = app
                .state::<p2p_state::IrohState>()
                .inner()
                .clone();
            tauri::async_runtime::spawn(async move {
                match team_p2p::IrohNode::new_default().await {
                    Ok(node) => {
                        *iroh_state.lock().await = Some(node);
                        #[cfg(debug_assertions)]
                        eprintln!("[P2P] iroh node started");
                    }
                    Err(e) => {
                        crate::sentry_utils::capture_err(
                            "[P2P] Failed to start iroh node",
                            &e,
                        );
                        eprintln!(
                            "[P2P] Failed to start iroh node (P2P disabled): {}",
                            e
                        );
                    }
                }
            });
        }

        Ok(())
    });

    plugin.build()
}
