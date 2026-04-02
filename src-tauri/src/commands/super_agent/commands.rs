use super::skill_distiller::SkillDistiller;
use super::state::SuperAgentState;
use super::strategy_engine::StrategyEngine;
use super::types::{
    AgentProfile, KnowledgeSnapshot, NerveMessage, NervePayload, NerveTopic, SuperAgentSnapshot,
    Task, TaskBoardSnapshot, TaskComplexity, TaskUrgency, ValidationStatus, now_millis,
};

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

/// Return a full snapshot of the collective knowledge board.
#[tauri::command]
pub async fn super_agent_get_knowledge(
    state: tauri::State<'_, SuperAgentState>,
) -> Result<KnowledgeSnapshot, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let bb = node.blackboard.lock().await;
    Ok(node.knowledge_board.get_snapshot(&bb))
}

/// Collect an experience from a completed task, store it, broadcast it, and
/// try to distil new strategies from the same domain.
#[tauri::command]
pub async fn super_agent_record_experience(
    task_id: String,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<(), String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    // Collect experience from the task.
    let exp = {
        let bb = node.blackboard.lock().await;
        let orch = node.orchestrator.lock().await;
        let task = orch
            .task_board
            .get_task(&bb, &task_id)
            .ok_or_else(|| format!("task {task_id} not found"))?;
        node.experience_collector
            .collect_from_task(&task)
            .ok_or_else(|| format!("task {task_id} is not in a terminal state or has no result"))?
    };

    // Store the experience.
    {
        let mut bb = node.blackboard.lock().await;
        node.knowledge_board.upsert_experience(&mut bb, &exp)?;
    }

    // Broadcast ExperienceNew — fire-and-forget.
    let msg = NerveMessage {
        id: nanoid::nanoid!(),
        topic: NerveTopic::Experience,
        from: node.local_node_id.clone(),
        timestamp: now_millis(),
        ttl: 60,
        payload: NervePayload::ExperienceNew {
            experience_id: exp.id.clone(),
            domain: exp.domain.clone(),
            summary: exp.result.clone(),
        },
    };
    node.nerve.broadcast(msg).await;

    // Try to distil strategies from domain experiences.
    let domain_experiences = {
        let bb = node.blackboard.lock().await;
        node.knowledge_board.get_experiences_by_domain(&bb, &exp.domain)
    };

    let new_strategies = node.strategy_engine.try_distill(&domain_experiences);

    // Store any newly distilled strategies.
    if !new_strategies.is_empty() {
        let mut bb = node.blackboard.lock().await;
        for strat in &new_strategies {
            node.knowledge_board.upsert_strategy(&mut bb, strat)?;
        }
    }

    Ok(())
}

/// Validate a strategy: add the local node to validated_by, upgrade status when
/// thresholds are met, and run SkillDistiller if the strategy is ready.
#[tauri::command]
pub async fn super_agent_validate_strategy(
    strategy_id: String,
    score: f64,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<(), String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    // Fetch, mutate, store.
    let mut strat = {
        let bb = node.blackboard.lock().await;
        node.knowledge_board
            .get_strategy(&bb, &strategy_id)
            .ok_or_else(|| format!("strategy {strategy_id} not found"))?
    };

    // Add local node to validated_by if not already present.
    if !strat.validation.validated_by.contains(&node.local_node_id) {
        strat.validation.validated_by.push(node.local_node_id.clone());
    }

    // Update running validation score (simple average with new score).
    let n = strat.validation.validated_by.len() as f64;
    strat.validation.validation_score =
        (strat.validation.validation_score * (n - 1.0) + score) / n;

    // Upgrade status: ≥2 validators + score ≥0.7 → Validated.
    if strat.validation.validated_by.len() >= 2
        && strat.validation.validation_score >= 0.7
        && strat.validation.status != ValidationStatus::Validated
    {
        strat.validation.status = ValidationStatus::Validated;
    }

    {
        let mut bb = node.blackboard.lock().await;
        node.knowledge_board.upsert_strategy(&mut bb, &strat)?;
    }

    // If ready for distillation, run SkillDistiller and store the result.
    if StrategyEngine::is_ready_for_distillation(&strat) {
        let skill = SkillDistiller::distill(&strat);
        let mut bb = node.blackboard.lock().await;
        node.knowledge_board.upsert_skill(&mut bb, &skill)?;
    }

    Ok(())
}
