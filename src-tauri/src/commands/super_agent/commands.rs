use super::state::SuperAgentState;
use super::types::{AgentProfile, NerveMessage, NervePayload, SuperAgentSnapshot, Task, TaskBoardSnapshot, TaskComplexity, TaskUrgency};

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

/// Create a new task, optionally broadcasting it for bidding if complexity is Delegate.
#[tauri::command]
pub async fn super_agent_create_task(
    description: String,
    required_capabilities: Vec<String>,
    urgency: String,
    complexity: String,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<Task, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let urgency_enum = match urgency.as_str() {
        "low" => TaskUrgency::Low,
        "high" => TaskUrgency::High,
        "critical" => TaskUrgency::Critical,
        _ => TaskUrgency::Normal,
    };
    let complexity_enum = match complexity.as_str() {
        "solo" => TaskComplexity::Solo,
        _ => TaskComplexity::Delegate,
    };

    let task = {
        let mut bb = node.blackboard.lock().await;
        node.orchestrator.lock().await.create_task(
            &mut bb,
            description.clone(),
            required_capabilities.clone(),
            urgency_enum.clone(),
            complexity_enum.clone(),
        )?
    };

    if complexity_enum == TaskComplexity::Delegate {
        let payload = NervePayload::TaskBroadcast {
            task_id: task.id.clone(),
            description,
            required_capabilities,
            urgency: urgency_enum,
        };
        let msg = NerveMessage::new_task(node.local_node_id.clone(), payload);
        node.nerve.broadcast(msg).await;
    }

    Ok(task)
}

/// Return a snapshot of all tasks on the task board.
#[tauri::command]
pub async fn super_agent_get_tasks(
    state: tauri::State<'_, SuperAgentState>,
) -> Result<TaskBoardSnapshot, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let bb = node.blackboard.lock().await;
    let orch = node.orchestrator.lock().await;
    let tasks = orch.task_board.get_all_tasks(&bb);

    Ok(TaskBoardSnapshot { tasks })
}
