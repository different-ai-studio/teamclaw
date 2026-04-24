// src-tauri/src/commands/team_unified.rs

use serde::{Deserialize, Serialize};
use tauri::State;

// --- Shared Types (canonical definitions in teamclaw-sync) ---
pub use teamclaw_sync::oss_types::{MemberRole, TeamManifest, TeamMember};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct TeamCreateResult {
    pub team_id: Option<String>,
    pub ticket: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct TeamJoinResult {
    pub success: bool,
    pub role: MemberRole,
    pub members: Vec<TeamMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "message")]
#[allow(dead_code)]
pub enum TeamJoinError {
    InvalidTicket(String),
    DeviceNotRegistered(String),
    AlreadyInTeam(String),
    SyncError(String),
}

impl std::fmt::Display for TeamJoinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidTicket(msg) => write!(f, "{}", msg),
            Self::DeviceNotRegistered(msg) => write!(f, "{}", msg),
            Self::AlreadyInTeam(msg) => write!(f, "{}", msg),
            Self::SyncError(msg) => write!(f, "{}", msg),
        }
    }
}

// --- Validation Helpers ---

/// Validate NodeId format: non-empty hex string
pub fn validate_node_id(node_id: &str) -> Result<(), String> {
    if node_id.is_empty() {
        return Err("NodeId cannot be empty".to_string());
    }
    if !node_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("NodeId must be a valid hex string".to_string());
    }
    Ok(())
}

/// Check if a role can manage members (add/remove/edit)
pub fn can_manage_members(role: &MemberRole) -> bool {
    matches!(role, MemberRole::Owner | MemberRole::Manager)
}

/// Find a member's role in a manifest by node_id
pub fn find_member_role(manifest: &TeamManifest, node_id: &str) -> Option<MemberRole> {
    manifest
        .members
        .iter()
        .find(|m| m.node_id == node_id)
        .map(|m| m.role.clone())
}

// --- Unified Tauri Commands ---

/// Helper: check that caller has Owner or Manager role by looking up their NodeId in the manifest.
/// Returns Err if they lack the required role.
async fn require_manager_role(manifest: &TeamManifest, caller_node_id: &str) -> Result<(), String> {
    let role = find_member_role(manifest, caller_node_id)
        .ok_or_else(|| "Your device is not in the team manifest".to_string())?;
    if !can_manage_members(&role) {
        return Err("Insufficient permissions: Owner or Manager role required".to_string());
    }
    Ok(())
}

#[cfg(feature = "p2p")]
async fn p2p_update_member_role_and_sync(
    workspace_path: &str,
    iroh_state: &super::p2p_state::IrohState,
    node_id: &str,
    role: MemberRole,
) -> Result<(), String> {
    let mut guard = iroh_state.lock().await;
    let node = guard.as_mut().ok_or("P2P node not running")?;
    let caller_node_id = super::team_p2p::get_node_id(node);
    let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
    if node.active_doc.is_none() {
        return Err(
            "No active team document — cannot sync role changes to peers. Reconnect to the team, then try again."
                .to_string(),
        );
    }

    let previous_role = super::team_p2p::read_members_manifest(&team_dir)?
        .map(|manifest| {
            manifest
                .members
                .into_iter()
                .find(|member| member.node_id == node_id)
                .map(|member| member.role)
        })
        .flatten()
        .or_else(|| {
            super::team_p2p::read_p2p_config(
                workspace_path,
                super::TEAMCLAW_DIR,
                super::CONFIG_FILE_NAME,
            )
            .ok()
            .flatten()
            .and_then(|config| {
                config
                    .allowed_members
                    .into_iter()
                    .find(|member| member.node_id == node_id)
                    .map(|member| member.role)
            })
        })
        .ok_or_else(|| "Member not found".to_string())?;

    super::team_p2p::update_member_role(
        workspace_path,
        &team_dir,
        &caller_node_id,
        node_id,
        role,
        super::TEAMCLAW_DIR,
        super::CONFIG_FILE_NAME,
    )?;

    let manifest_path = format!("{}/{}", team_dir, "_team/members.json");
    let content = match std::fs::read(&manifest_path) {
        Ok(content) => content,
        Err(e) => {
            let _ = super::team_p2p::update_member_role(
                workspace_path,
                &team_dir,
                &caller_node_id,
                node_id,
                previous_role,
                super::TEAMCLAW_DIR,
                super::CONFIG_FILE_NAME,
            );
            return Err(format!(
                "Could not read members.json after role update (local role restored): {}",
                e
            ));
        }
    };

    let doc = node.active_doc.as_ref().expect("checked active_doc above");
    if let Err(e) = doc
        .set_bytes(node.author, "_team/members.json", content)
        .await
    {
        let _ = super::team_p2p::update_member_role(
            workspace_path,
            &team_dir,
            &caller_node_id,
            node_id,
            previous_role,
            super::TEAMCLAW_DIR,
            super::CONFIG_FILE_NAME,
        );
        return Err(format!(
            "Failed to sync role change to the team document (local role restored): {}. Reconnect and try again.",
            e
        ));
    }

    Ok(())
}

// ─── Git mode manifest helpers ──────────────────────────────────────────────

fn git_manifest_path(workspace_path: &str) -> std::path::PathBuf {
    std::path::Path::new(workspace_path)
        .join(super::TEAM_REPO_DIR)
        .join("_meta")
        .join("members.json")
}

/// Read manifest, auto-creating with self as owner if missing.
fn read_git_manifest(workspace_path: &str) -> Result<TeamManifest, String> {
    let path = git_manifest_path(workspace_path);
    if let Ok(content) = std::fs::read_to_string(&path) {
        return serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse members.json: {}", e));
    }
    // Auto-create with self as owner
    let node_id = super::oss_commands::get_device_id()?;
    let manifest = TeamManifest {
        owner_node_id: node_id.clone(),
        members: vec![TeamMember {
            node_id,
            name: String::new(),
            role: MemberRole::Owner,
            shortcuts_role: Vec::new(),
            label: String::new(),
            platform: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            hostname: gethostname::gethostname().to_string_lossy().to_string(),
            added_at: chrono::Utc::now().to_rfc3339(),
        }],
    };
    write_git_manifest(workspace_path, &manifest)?;
    Ok(manifest)
}

fn write_git_manifest(workspace_path: &str, manifest: &TeamManifest) -> Result<(), String> {
    let path = git_manifest_path(workspace_path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Failed to serialize members.json: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write members.json: {}", e))
}

/// Get the list of team members from the active sync mode.
/// - OSS: reads from local cache, falls back to S3
/// - P2P: reads from p2p config's allowed_members
/// - Git: reads from teamclaw-team/_meta/members.json
#[tauri::command]
pub async fn unified_team_get_members(
    workspace_path: Option<String>,
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    oss_state: State<'_, super::oss_sync::OssSyncState>,
    iroh_state: State<'_, super::p2p_state::IrohState>,
) -> Result<Vec<TeamMember>, String> {
    let workspace_path = super::team::resolve_workspace_path(workspace_path, &opencode_state)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        Some("oss") => {
            // Read from local cache first (synced every ~5 min), fall back to S3
            let cache_path = std::path::Path::new(&workspace_path)
                .join(super::TEAMCLAW_DIR)
                .join("_team")
                .join("members.json");
            if let Ok(content) = std::fs::read_to_string(&cache_path) {
                if let Ok(manifest) = serde_json::from_str::<TeamManifest>(&content) {
                    return Ok(manifest.members);
                }
            }
            // Cache miss — download from S3
            let guard = oss_state.manager.lock().await;
            let manager = guard.as_ref().ok_or("OSS sync not initialized")?;
            let manifest = manager
                .download_and_cache_members_manifest()
                .await?
                .ok_or("No members manifest found")?;
            Ok(manifest.members)
        }
        #[cfg(feature = "p2p")]
        Some("p2p") => {
            let _ = iroh_state;
            // Prefer the synced manifest (_team/members.json) as it reflects the
            // authoritative member list. Fall back to local config for the owner
            // who may not have a manifest yet.
            let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
            if let Ok(Some(manifest)) = super::team_p2p::read_members_manifest(&team_dir) {
                Ok(manifest.members)
            } else {
                let config = super::team_p2p::read_p2p_config(
                    &workspace_path,
                    super::TEAMCLAW_DIR,
                    super::CONFIG_FILE_NAME,
                )?
                .unwrap_or_default();
                Ok(config.allowed_members)
            }
        }
        Some("git") => {
            let manifest = read_git_manifest(&workspace_path)?;
            Ok(manifest.members)
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

/// Add a member to the active team.
/// Validates NodeId format, checks caller role, then adds member.
#[tauri::command]
pub async fn unified_team_add_member(
    member: TeamMember,
    workspace_path: Option<String>,
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    oss_state: State<'_, super::oss_sync::OssSyncState>,
    iroh_state: State<'_, super::p2p_state::IrohState>,
) -> Result<(), String> {
    validate_node_id(&member.node_id)?;

    let workspace_path = super::team::resolve_workspace_path(workspace_path, &opencode_state)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        Some("oss") => {
            let guard = oss_state.manager.lock().await;
            let manager = guard.as_ref().ok_or("OSS sync not initialized")?;
            let manifest = manager.download_members_manifest().await?;
            if let Some(ref m) = manifest {
                let caller_node_id = manager.node_id().to_string();
                require_manager_role(m, &caller_node_id).await?;
            } else if !can_manage_members(&manager.role()) {
                return Err("Insufficient permissions: Owner or Manager role required".to_string());
            }
            manager.add_member(member).await
        }
        #[cfg(feature = "p2p")]
        Some("p2p") => {
            let mut guard = iroh_state.lock().await;
            let node = guard.as_mut().ok_or("P2P node not running")?;
            let caller_node_id = super::team_p2p::get_node_id(node);
            let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
            if node.active_doc.is_none() {
                return Err(
                    "No active team document — cannot sync members to peers. Reconnect to the team (or restart the app), then try again."
                        .to_string(),
                );
            }
            let added_node_id = member.node_id.clone();
            super::team_p2p::add_member_to_team(
                &workspace_path,
                &team_dir,
                &caller_node_id,
                member,
                super::TEAMCLAW_DIR,
                super::CONFIG_FILE_NAME,
            )?;
            // Push updated members.json to Iroh doc immediately (don't rely on fs watcher).
            // Joiners authorize against the doc, not only local disk.
            let manifest_path = format!("{}/{}", team_dir, "_team/members.json");
            let content = match std::fs::read(&manifest_path) {
                Ok(c) => c,
                Err(e) => {
                    let _ = super::team_p2p::remove_member_from_team(
                        &workspace_path,
                        &team_dir,
                        &caller_node_id,
                        &added_node_id,
                        super::TEAMCLAW_DIR,
                        super::CONFIG_FILE_NAME,
                    );
                    return Err(format!(
                        "Could not read members.json after add (rolled back): {}",
                        e
                    ));
                }
            };
            let doc = node.active_doc.as_ref().expect("checked active_doc above");
            if let Err(e) = doc
                .set_bytes(node.author, "_team/members.json", content)
                .await
            {
                let _ = super::team_p2p::remove_member_from_team(
                    &workspace_path,
                    &team_dir,
                    &caller_node_id,
                    &added_node_id,
                    super::TEAMCLAW_DIR,
                    super::CONFIG_FILE_NAME,
                );
                return Err(format!(
                    "Failed to sync members to the team document (rolled back): {}. Reconnect and try again.",
                    e
                ));
            }
            drop(guard);
            Ok(())
        }
        Some("git") => {
            // Git mode: anyone with repo access can manage members
            let mut manifest = read_git_manifest(&workspace_path)?;
            if manifest.members.iter().any(|m| m.node_id == member.node_id) {
                return Err("Member already exists".to_string());
            }
            manifest.members.push(member);
            write_git_manifest(&workspace_path, &manifest)?;
            Ok(())
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

/// Remove a member from the active team.
/// Checks caller role before removing.
#[tauri::command]
pub async fn unified_team_remove_member(
    node_id: String,
    workspace_path: Option<String>,
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    oss_state: State<'_, super::oss_sync::OssSyncState>,
    iroh_state: State<'_, super::p2p_state::IrohState>,
) -> Result<(), String> {
    let workspace_path = super::team::resolve_workspace_path(workspace_path, &opencode_state)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        Some("oss") => {
            let guard = oss_state.manager.lock().await;
            let manager = guard.as_ref().ok_or("OSS sync not initialized")?;
            let caller_node_id = manager.node_id().to_string();
            let manifest = manager
                .download_members_manifest()
                .await?
                .ok_or("No members manifest found")?;
            require_manager_role(&manifest, &caller_node_id).await?;
            drop(guard);
            let guard = oss_state.manager.lock().await;
            let manager = guard.as_ref().ok_or("OSS sync not initialized")?;
            manager.remove_member(&node_id).await
        }
        #[cfg(feature = "p2p")]
        Some("p2p") => {
            let mut guard = iroh_state.lock().await;
            let node = guard.as_mut().ok_or("P2P node not running")?;
            let caller_node_id = super::team_p2p::get_node_id(node);
            let team_dir = format!("{}/{}", workspace_path, super::TEAM_REPO_DIR);
            if node.active_doc.is_none() {
                return Err(
                    "No active team document — cannot sync removal to peers. Reconnect to the team, then try again."
                        .to_string(),
                );
            }
            let member_snapshot = super::team_p2p::read_p2p_config(
                &workspace_path,
                super::TEAMCLAW_DIR,
                super::CONFIG_FILE_NAME,
            )?
            .ok_or_else(|| "No P2P config found".to_string())?
            .allowed_members
            .iter()
            .find(|m| m.node_id == node_id)
            .cloned()
            .ok_or_else(|| "Member not found".to_string())?;

            super::team_p2p::remove_member_from_team(
                &workspace_path,
                &team_dir,
                &caller_node_id,
                &node_id,
                super::TEAMCLAW_DIR,
                super::CONFIG_FILE_NAME,
            )?;

            let manifest_path = format!("{}/{}", team_dir, "_team/members.json");
            let content = match std::fs::read(&manifest_path) {
                Ok(c) => c,
                Err(e) => {
                    if let Err(revert_e) = super::team_p2p::add_member_to_team(
                        &workspace_path,
                        &team_dir,
                        &caller_node_id,
                        member_snapshot.clone(),
                        super::TEAMCLAW_DIR,
                        super::CONFIG_FILE_NAME,
                    ) {
                        return Err(format!(
                            "Could not read members.json after remove (restore failed): read {}, revert {}",
                            e, revert_e
                        ));
                    }
                    return Err(format!(
                        "Could not read members.json after remove (local list restored): {}",
                        e
                    ));
                }
            };

            let doc = node.active_doc.as_ref().expect("checked active_doc above");
            if let Err(e) = doc
                .set_bytes(node.author, "_team/members.json", content)
                .await
            {
                if let Err(revert_e) = super::team_p2p::add_member_to_team(
                    &workspace_path,
                    &team_dir,
                    &caller_node_id,
                    member_snapshot,
                    super::TEAMCLAW_DIR,
                    super::CONFIG_FILE_NAME,
                ) {
                    return Err(format!(
                        "Failed to sync removal to the team document: {}. Also failed to restore local member list: {}.",
                        e, revert_e
                    ));
                }
                return Err(format!(
                    "Failed to sync removal to the team document (local list restored): {}. Reconnect and try removing again.",
                    e
                ));
            }
            drop(guard);
            Ok(())
        }
        Some("git") => {
            let mut manifest = read_git_manifest(&workspace_path)?;
            manifest.members.retain(|m| m.node_id != node_id);
            write_git_manifest(&workspace_path, &manifest)?;
            Ok(())
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

/// Update a team member's role.
/// Checks caller role before updating.
#[tauri::command]
pub async fn unified_team_update_member_role(
    node_id: String,
    role: MemberRole,
    workspace_path: Option<String>,
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    oss_state: State<'_, super::oss_sync::OssSyncState>,
    iroh_state: State<'_, super::p2p_state::IrohState>,
) -> Result<(), String> {
    let workspace_path = super::team::resolve_workspace_path(workspace_path, &opencode_state)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        Some("oss") => {
            let guard = oss_state.manager.lock().await;
            let manager = guard.as_ref().ok_or("OSS sync not initialized")?;
            let caller_node_id = manager.node_id().to_string();
            let manifest = manager
                .download_members_manifest()
                .await?
                .ok_or("No members manifest found")?;
            require_manager_role(&manifest, &caller_node_id).await?;
            drop(guard);
            let guard = oss_state.manager.lock().await;
            let manager = guard.as_ref().ok_or("OSS sync not initialized")?;
            manager.update_member_role(&node_id, role).await
        }
        #[cfg(feature = "p2p")]
        Some("p2p") => {
            p2p_update_member_role_and_sync(&workspace_path, iroh_state.inner(), &node_id, role)
                .await
        }
        Some("git") => {
            let mut manifest = read_git_manifest(&workspace_path)?;
            if let Some(member) = manifest.members.iter_mut().find(|m| m.node_id == node_id) {
                member.role = role;
            } else {
                return Err("Member not found".to_string());
            }
            write_git_manifest(&workspace_path, &manifest)?;
            Ok(())
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

/// Get the current device's role in the active team.
#[tauri::command]
pub async fn unified_team_get_my_role(
    workspace_path: Option<String>,
    opencode_state: State<'_, super::opencode::OpenCodeState>,
    oss_state: State<'_, super::oss_sync::OssSyncState>,
    iroh_state: State<'_, super::p2p_state::IrohState>,
) -> Result<MemberRole, String> {
    let workspace_path = super::team::resolve_workspace_path(workspace_path, &opencode_state)?;
    let status = super::team::check_team_status(&workspace_path);

    match status.mode.as_deref() {
        Some("oss") => {
            let guard = oss_state.manager.lock().await;
            let manager = guard.as_ref().ok_or("OSS sync not initialized")?;
            let my_node_id = manager.node_id().to_string();
            let manifest = manager
                .download_members_manifest()
                .await?
                .ok_or("No members manifest found")?;
            find_member_role(&manifest, &my_node_id)
                .ok_or_else(|| "This device is not in the team manifest".to_string())
        }
        #[cfg(feature = "p2p")]
        Some("p2p") => {
            let _ = iroh_state;
            let config = super::team_p2p::read_p2p_config(
                &workspace_path,
                super::TEAMCLAW_DIR,
                super::CONFIG_FILE_NAME,
            )?
            .ok_or("No P2P config found")?;
            config
                .role
                .ok_or_else(|| "Role not set in P2P config".to_string())
        }
        Some("git") => {
            let my_node_id = super::oss_commands::get_device_id()?;
            let manifest = read_git_manifest(&workspace_path)?;
            // In Git mode, if device not in manifest, treat as owner
            // (anyone with repo access is implicitly authorized)
            Ok(find_member_role(&manifest, &my_node_id).unwrap_or(MemberRole::Owner))
        }
        Some(mode) => Err(format!(
            "Member management not supported for mode: {}",
            mode
        )),
        None => Err("No active team mode".to_string()),
    }
}

#[cfg(all(test, feature = "p2p"))]
mod tests {
    use super::*;
    use crate::commands::team_p2p::{
        add_member_to_team, create_team, get_node_id, join_team_drive, read_members_manifest,
        IrohNode, SyncEngine,
    };
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::sync::Mutex;

    struct TestPeer {
        name: String,
        workspace_dir: tempfile::TempDir,
        _iroh_storage_dir: tempfile::TempDir,
        team_dir: PathBuf,
        node: IrohNode,
        engine: super::super::p2p_state::SyncEngineState,
    }

    impl TestPeer {
        async fn new(name: &str) -> Self {
            let workspace_dir = tempfile::tempdir().unwrap();
            let iroh_storage_dir = tempfile::tempdir().unwrap();
            let team_dir = workspace_dir.path().join(crate::commands::TEAM_REPO_DIR);
            std::fs::create_dir_all(&team_dir).unwrap();
            let node = IrohNode::new(iroh_storage_dir.path()).await.unwrap();

            Self {
                name: name.to_string(),
                workspace_dir,
                _iroh_storage_dir: iroh_storage_dir,
                team_dir,
                node,
                engine: Arc::new(Mutex::new(SyncEngine::new())),
            }
        }

        fn workspace_path(&self) -> String {
            self.workspace_dir.path().to_string_lossy().to_string()
        }

        fn team_dir_path(&self) -> String {
            self.team_dir.to_string_lossy().to_string()
        }

        fn node_id(&self) -> String {
            get_node_id(&self.node)
        }

        fn member(&self, role: MemberRole) -> TeamMember {
            TeamMember {
                node_id: self.node_id(),
                name: self.name.clone(),
                role,
                shortcuts_role: Vec::new(),
                label: self.name.clone(),
                platform: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
                hostname: format!("{}-host", self.name.to_lowercase()),
                added_at: chrono::Utc::now().to_rfc3339(),
            }
        }

        async fn create_team(&mut self) -> String {
            let workspace_path = self.workspace_path();
            let team_dir = self.team_dir_path();
            create_team(
                &mut self.node,
                &team_dir,
                &workspace_path,
                Some("Unified Team Test".to_string()),
                Some(self.name.clone()),
                None,
                None,
                self.engine.clone(),
                crate::commands::TEAMCLAW_DIR,
                crate::commands::CONFIG_FILE_NAME,
                crate::commands::TEAM_REPO_DIR,
            )
            .await
            .unwrap()
        }

        async fn join_team(&mut self, ticket: &str) {
            let workspace_path = self.workspace_path();
            let team_dir = self.team_dir_path();
            join_team_drive(
                &mut self.node,
                ticket,
                &team_dir,
                &workspace_path,
                None,
                self.engine.clone(),
                crate::commands::TEAMCLAW_DIR,
                crate::commands::CONFIG_FILE_NAME,
                crate::commands::TEAM_REPO_DIR,
            )
            .await
            .unwrap();
        }

        fn manifest(&self) -> TeamManifest {
            read_members_manifest(&self.team_dir_path())
                .unwrap()
                .expect("members manifest should exist")
        }

        async fn shutdown(self) {
            self.node.shutdown().await;
        }
    }

    async fn wait_until(timeout: Duration, mut check: impl FnMut() -> bool, description: &str) {
        let start = Instant::now();
        loop {
            if check() {
                return;
            }
            assert!(
                start.elapsed() < timeout,
                "timed out waiting for {} after {:?}",
                description,
                timeout
            );
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    #[tokio::test]
    #[ignore = "Uses real iroh nodes and file watchers; run explicitly with --ignored --test-threads=1"]
    async fn test_p2p_update_member_role_and_sync_updates_remote_manifest() {
        let mut owner = TestPeer::new("Owner").await;
        let mut joiner = TestPeer::new("Joiner").await;

        let ticket = owner.create_team().await;
        let joiner_member = joiner.member(MemberRole::Editor);
        let joiner_node_id = joiner_member.node_id.clone();
        add_member_to_team(
            &owner.workspace_path(),
            &owner.team_dir_path(),
            &owner.node_id(),
            joiner_member,
            crate::commands::TEAMCLAW_DIR,
            crate::commands::CONFIG_FILE_NAME,
        )
        .unwrap();

        let members_manifest = std::fs::read(owner.team_dir.join("_team/members.json")).unwrap();
        owner
            .node
            .active_doc
            .as_ref()
            .expect("owner should have active doc")
            .set_bytes(owner.node.author, "_team/members.json", members_manifest)
            .await
            .unwrap();

        joiner.join_team(&ticket).await;

        wait_until(
            Duration::from_secs(15),
            || {
                joiner
                    .manifest()
                    .members
                    .iter()
                    .find(|member| member.node_id == joiner_node_id)
                    .map(|member| member.role.clone())
                    == Some(MemberRole::Editor)
            },
            "joiner sees initial editor role",
        )
        .await;

        let owner_workspace_path = owner.workspace_path();
        let owner_state: super::super::p2p_state::IrohState =
            Arc::new(Mutex::new(Some(owner.node)));

        p2p_update_member_role_and_sync(
            &owner_workspace_path,
            &owner_state,
            &joiner_node_id,
            MemberRole::Viewer,
        )
        .await
        .unwrap();

        wait_until(
            Duration::from_secs(15),
            || {
                joiner
                    .manifest()
                    .members
                    .iter()
                    .find(|member| member.node_id == joiner_node_id)
                    .map(|member| member.role.clone())
                    == Some(MemberRole::Viewer)
            },
            "joiner receives viewer role from unified helper",
        )
        .await;

        let owner_node = owner_state
            .lock()
            .await
            .take()
            .expect("owner node should still be present");
        owner.node = owner_node;

        owner.shutdown().await;
        joiner.shutdown().await;
    }
}
