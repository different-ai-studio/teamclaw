use super::skill_distiller::SkillDistiller;
use super::state::SuperAgentState;
use super::strategy_engine::StrategyEngine;
use super::types::{
    AgentProfile, Angle, DebateSnapshot, DeliberationTrigger, KnowledgeSnapshot, NerveMessage,
    NervePayload, NerveTopic, Perspective, PostDecisionOutcome, SuperAgentSnapshot, SynthesisResult,
    Task, TaskBoardSnapshot, TaskComplexity, TaskUrgency, ValidationStatus, Vote, VoteRanking,
    now_millis,
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

    // Hold the blackboard lock for the entire critical section to prevent TOCTOU:
    // read task → store experience → run distillation → store strategies.
    let (exp, new_strategies) = {
        let mut bb = node.blackboard.lock().await;
        let orch = node.orchestrator.lock().await;
        let task = orch
            .task_board
            .get_task(&bb, &task_id)
            .ok_or_else(|| format!("task {task_id} not found"))?;
        let exp = node.experience_collector
            .collect_from_task(&task)
            .ok_or_else(|| format!("task {task_id} is not in a terminal state or has no result"))?;

        node.knowledge_board.upsert_experience(&mut bb, &exp)?;

        let domain_experiences = node.knowledge_board.get_experiences_by_domain(&bb, &exp.domain);
        let new_strategies = node.strategy_engine.try_distill(&domain_experiences);

        for strat in &new_strategies {
            node.knowledge_board.upsert_strategy(&mut bb, strat)?;
        }

        (exp, new_strategies)
    };

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

    let _ = new_strategies; // used above; bind here to satisfy compiler

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

// ─── Layer 4: Deliberation / Debate Commands ──────────────────────────────────

/// Start a deliberation on a question, broadcasting a DebatePropose message.
#[tauri::command]
pub async fn super_agent_start_deliberation(
    question: String,
    context: String,
    requested_angles: Vec<String>,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<(), String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let angles: Vec<Angle> = requested_angles
        .iter()
        .map(|s| match s.as_str() {
            "feasibility" => Angle::Feasibility,
            "performance" => Angle::Performance,
            "security" => Angle::Security,
            "maintainability" => Angle::Maintainability,
            "user_experience" | "userexperience" => Angle::UserExperience,
            "cost" => Angle::Cost,
            "risk" => Angle::Risk,
            _ => Angle::Feasibility,
        })
        .collect();

    let trigger = DeliberationTrigger {
        explicit: true,
        creator_confidence: 0.5,
        domain_failure_rate: 0.0,
        cross_domain_count: 0,
    };

    let debate = {
        let engine = node.deliberation_engine.lock().await;
        let mut bb = node.blackboard.lock().await;
        engine.create_deliberation(
            &mut bb,
            question.clone(),
            context.clone(),
            angles.clone(),
            trigger,
        )?
    };

    let msg = NerveMessage::new_debate(
        node.local_node_id.clone(),
        NervePayload::DebatePropose {
            debate_id: debate.id.clone(),
            question,
            context,
            deadline: debate.deadline,
            requested_angles: angles,
        },
    );
    node.nerve.broadcast(msg).await;

    Ok(())
}

/// Return a snapshot of all debates on the debate board.
#[tauri::command]
pub async fn super_agent_get_debates(
    state: tauri::State<'_, SuperAgentState>,
) -> Result<DebateSnapshot, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let engine = node.deliberation_engine.lock().await;
    let bb = node.blackboard.lock().await;
    Ok(engine.debate_board.get_snapshot(&bb))
}

/// Submit a perspective to an existing debate, broadcasting a DebatePerspective message.
#[tauri::command]
pub async fn super_agent_submit_perspective(
    debate_id: String,
    angle: String,
    position: String,
    reasoning: String,
    confidence: f64,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<(), String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let angle_enum = match angle.as_str() {
        "feasibility" => Angle::Feasibility,
        "performance" => Angle::Performance,
        "security" => Angle::Security,
        "maintainability" => Angle::Maintainability,
        "user_experience" | "userexperience" => Angle::UserExperience,
        "cost" => Angle::Cost,
        "risk" => Angle::Risk,
        _ => Angle::Feasibility,
    };

    let perspective = Perspective {
        debate_id: debate_id.clone(),
        agent_id: node.local_node_id.clone(),
        angle: angle_enum.clone(),
        position: position.clone(),
        reasoning,
        evidence: vec![],
        risks: vec![],
        preferred_option: String::new(),
        option_ranking: vec![],
        confidence,
    };

    {
        let engine = node.deliberation_engine.lock().await;
        let mut bb = node.blackboard.lock().await;
        engine.add_perspective(&mut bb, &debate_id, perspective)?;
    }

    let msg = NerveMessage::new_debate(
        node.local_node_id.clone(),
        NervePayload::DebatePerspective {
            debate_id,
            agent_id: node.local_node_id.clone(),
            angle: angle_enum,
            position,
            confidence,
        },
    );
    node.nerve.broadcast(msg).await;

    Ok(())
}

/// Submit a vote on a debate, broadcasting a DebateVote message.
#[tauri::command]
pub async fn super_agent_submit_vote(
    debate_id: String,
    preferred_option_id: String,
    ranking: Vec<(String, u32)>,
    reasoning: String,
    confidence: f64,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<(), String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let vote_ranking: Vec<VoteRanking> = ranking
        .into_iter()
        .map(|(option_id, rank)| VoteRanking { option_id, rank })
        .collect();

    let vote = Vote {
        agent_id: node.local_node_id.clone(),
        preferred_option_id,
        ranking: vote_ranking,
        confidence,
        final_reasoning: reasoning,
    };

    {
        let engine = node.deliberation_engine.lock().await;
        let mut bb = node.blackboard.lock().await;
        engine.add_vote(&mut bb, &debate_id, vote)?;
    }

    let msg = NerveMessage::new_debate(
        node.local_node_id.clone(),
        NervePayload::DebateVote {
            debate_id,
        },
    );
    node.nerve.broadcast(msg).await;

    Ok(())
}

/// Resolve the bidding phase for a task by selecting the winner and assigning the task.
#[tauri::command]
pub async fn super_agent_resolve_bidding(
    task_id: String,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<Task, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let mut bb = node.blackboard.lock().await;
    let orch = node.orchestrator.lock().await;

    let winner = orch.select_winner(&bb, &task_id)
        .ok_or("No bids received")?;

    orch.assign_task(&mut bb, &task_id, winner.clone())?;

    // Broadcast assignment
    let payload = NervePayload::TaskAssign {
        task_id: task_id.clone(),
        assignee: winner.clone(),
    };
    let msg = NerveMessage::new_task(node.local_node_id.clone(), payload);
    drop(orch);
    drop(bb);
    node.nerve.broadcast(msg).await;

    let bb = node.blackboard.lock().await;
    let orch = node.orchestrator.lock().await;
    orch.task_board.get_task(&bb, &task_id)
        .ok_or_else(|| format!("Task {task_id} not found after assignment"))
}

/// Run ranked-choice voting over a debate's candidate options and conclude the debate.
#[tauri::command]
pub async fn super_agent_conclude_deliberation(
    debate_id: String,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<SynthesisResult, String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let engine = node.deliberation_engine.lock().await;
    let mut bb = node.blackboard.lock().await;
    engine.run_voting_and_conclude(&mut bb, &debate_id)
}

/// Record a post-decision outcome for a debate.
#[tauri::command]
pub async fn super_agent_record_outcome(
    debate_id: String,
    task_id: String,
    actual_result: String,
    score: f64,
    was_correct: bool,
    state: tauri::State<'_, SuperAgentState>,
) -> Result<(), String> {
    let guard = state.lock().await;
    let node = guard.as_ref().ok_or("Super Agent not initialized")?;

    let outcome = PostDecisionOutcome {
        task_id,
        actual_result,
        score,
        was_correct_decision: was_correct,
    };

    let engine = node.deliberation_engine.lock().await;
    let mut bb = node.blackboard.lock().await;
    engine.record_outcome(&mut bb, &debate_id, outcome)
}
