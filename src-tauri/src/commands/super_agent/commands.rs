use super::state::SuperAgentState;
use super::types::{AgentProfile, SuperAgentSnapshot};

/// Return a snapshot of the current super-agent state (local profile + all known agents).
#[tauri::command]
pub async fn super_agent_snapshot(
    state: tauri::State<'_, SuperAgentState>,
) -> Result<SuperAgentSnapshot, String> {
    let guard = state.lock().await;
    let node = guard
        .as_ref()
        .ok_or_else(|| "super-agent node is not running".to_string())?;

    let registry = node.registry.lock().await;
    let blackboard = node.blackboard.lock().await;

    Ok(SuperAgentSnapshot {
        local_agent: registry.local_profile().cloned(),
        agents: registry.get_all_agents(&blackboard),
        connected: true,
    })
}

/// Discover agents capable in `domain`, sorted by capability score (best first).
#[tauri::command]
pub async fn super_agent_discover(
    domain: String,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<Vec<AgentProfile>, String> {
    let guard = state.lock().await;
    let node = guard
        .as_ref()
        .ok_or_else(|| "super-agent node is not running".to_string())?;

    let registry = node.registry.lock().await;
    let blackboard = node.blackboard.lock().await;

    Ok(registry.discover_agents(&blackboard, &domain))
}
