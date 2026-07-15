import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Modal } from "react-native";

import { useConnectedAgentsStore, useOnboarding, useTeamMqtt } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { isAgentActor, type Actor } from "../../src/features/actors/actor-types";
import {
  resolveAgentRuntimeRestartPlan,
  resolveAgentRuntimeStartPlans,
} from "../../src/features/sessions/runtime-start";
import { createConfiguredSessionsApi } from "../../src/features/sessions/api-provider";
import { createWorkspacesApi } from "../../src/features/workspaces/workspace-api";
import { MemberPickerSheet } from "../../src/features/sessions/screens/MemberPickerSheet";
import { SessionMemberSheet } from "../../src/features/sessions/screens/SessionMemberSheet";
import { supabase } from "../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { createRuntimeRpcClient } from "../../src/lib/teamclaw/runtime-rpc";
import { showToast } from "../../src/ui/Toast";
import { TextPromptModal } from "../../src/ui/TextPromptModal";

type AddMode = "all" | "members" | "agents";

type AgentRuntime = {
  dbRuntimeId: string;
  runtimeId: string;
  agentId: string;
  workspaceId: string | null;
  backendType: string | null;
  currentModel: string | null;
  status: string;
};

type WorkspaceRow = {
  id: string;
  path: string | null;
  agent_id: string | null;
};

export default function SessionMembersRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const teamMqtt = useTeamMqtt();
  const connectedAgentsStore = useConnectedAgentsStore();
  const params = useLocalSearchParams<{ sessionId?: string }>();
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  const teamId = state.currentTeam?.id ?? "";

  const [actors, setActors] = useState<Actor[]>([]);
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntime[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [addMode, setAddMode] = useState<AddMode | null>(null);
  const [modelPromptAgent, setModelPromptAgent] = useState<AgentRuntime | null>(
    null,
  );

  useEffect(() => {
    if (!teamId || !sessionId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    const sessionsApi = createConfiguredSessionsApi(supabase);
    const actorsApi = createActorsApi({ getAccessToken: supabaseAccessToken(supabase) });
    const workspacesApi = createWorkspacesApi({ getAccessToken: supabaseAccessToken(supabase) });
    void Promise.all([
      sessionsApi.getSession(teamId, sessionId),
      actorsApi.listActors(teamId),
      sessionsApi.listSessionRuntimes(sessionId),
      workspacesApi.list(teamId),
    ])
      .then(([session, allActors, runtimeRows, workspaceRows]) => {
        if (cancelled) return;
        setParticipantIds(session?.participantActorIds ?? []);
        setActors(allActors);
        const rows: AgentRuntime[] = runtimeRows
          .filter((row): row is typeof row & { agentId: string } => Boolean(row.agentId))
          .map((row) => ({
            dbRuntimeId: row.dbRuntimeId,
            runtimeId: row.runtimeId,
            agentId: row.agentId,
            workspaceId: row.workspaceId,
            backendType: row.backendType,
            currentModel: row.currentModel,
            status: row.status,
          }));
        setRuntimes(rows);
        setWorkspaces(
          workspaceRows
            .filter((row) => !row.archived)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((row) => ({ id: row.id, path: row.path, agent_id: row.agentId })),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setActors([]);
        setParticipantIds([]);
        setRuntimes([]);
        setWorkspaces([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, teamId]);

  useEffect(() => {
    void connectedAgentsStore?.reload();
  }, [connectedAgentsStore]);

  const participants = useMemo(() => {
    if (participantIds.length === 0) return actors;
    const ids = new Set(participantIds);
    return actors.filter((actor) => ids.has(actor.actorId));
  }, [actors, participantIds]);

  const pickerCandidates = useMemo(() => {
    if (!addMode) return [] as Actor[];
    if (addMode === "members") return actors.filter((actor) => actor.actorType === "member");
    if (addMode === "agents") return actors.filter(isAgentActor);
    return actors;
  }, [actors, addMode]);

  const agentModelByActorId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const runtime of runtimes) {
      map.set(runtime.agentId, runtime.currentModel);
    }
    return map;
  }, [runtimes]);

  const findRuntimeForAgent = (actorId: string): AgentRuntime | null => {
    return runtimes.find((row) => row.agentId === actorId) ?? null;
  };

  const handleRemove = async (actorId: string) => {
    if (!sessionId) return;
    try {
      await createConfiguredSessionsApi(supabase).removeParticipant(sessionId, actorId);
      setParticipantIds((prev) => prev.filter((id) => id !== actorId));
      showToast("success", "Removed from session");
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Couldn't remove participant",
      );
    }
  };

  const handleAdd = async (picked: string[]) => {
    if (!sessionId || !teamId) {
      setAddMode(null);
      return;
    }
    const fresh = picked.filter((id) => !participantIds.includes(id));
    if (fresh.length === 0) {
      setAddMode(null);
      return;
    }
    try {
      const actorById = new Map(actors.map((actor) => [actor.actorId, actor]));
      const freshAgents = fresh
        .map((id) => actorById.get(id))
        .filter((actor): actor is Actor => Boolean(actor && isAgentActor(actor)));
      if (freshAgents.length > 0 && !state.currentMemberActorId) {
        throw new Error("Couldn't resolve your member identity in this team.");
      }
      if (freshAgents.length > 0 && !teamMqtt) {
        throw new Error("MQTT is not connected — wait for Teamclaw to reconnect.");
      }
      if (freshAgents.length > 0 && !connectedAgentsStore) {
        throw new Error("Connected agents are not ready — wait for Teamclaw to reconnect.");
      }
      if (freshAgents.length > 0) {
        await connectedAgentsStore?.reload();
      }
      const runtimePlans =
        freshAgents.length > 0
          ? resolveAgentRuntimeStartPlans({
              agents: freshAgents.map((actor) => ({
                actorId: actor.actorId,
                displayName: actor.displayName,
                agentTypes: actor.agentTypes,
                defaultAgentType: actor.defaultAgentType,
                defaultWorkspaceId: actor.defaultWorkspaceId ?? null,
              })),
              connectedAgents:
                connectedAgentsStore?.getState().agents.map((agent) => ({
                  agentId: agent.agentId,
                })) ?? [],
              workspaces: workspaces.map((workspace) => ({
                id: workspace.id,
                path: workspace.path ?? "",
                agentId: workspace.agent_id,
              })),
            })
          : [];
      await createConfiguredSessionsApi(supabase).addParticipants(sessionId, fresh);
      setParticipantIds((prev) => Array.from(new Set([...prev, ...fresh])));
      if (runtimePlans.length > 0 && teamMqtt && state.currentMemberActorId) {
        const runtimeRpc = createRuntimeRpcClient({
          mqtt: teamMqtt,
          teamId,
          requesterActorId: state.currentMemberActorId,
        });
        for (const plan of runtimePlans) {
          const actorName =
            actorById.get(plan.agentActorId)?.displayName ?? "Agent";
          void runtimeRpc.runtimeStart({
            targetActorId: plan.targetActorId,
            workspaceId: plan.workspaceId,
            worktree: plan.worktree,
            sessionId,
            agentType: plan.agentType,
            initialPrompt: "",
          }).catch((err) => {
            showToast(
              "error",
              err instanceof Error
                ? `Couldn't start ${actorName}: ${err.message}`
                : `Couldn't start ${actorName}.`,
            );
          });
        }
      }
      showToast(
        "success",
        fresh.length === 1 ? "Added to session" : `Added ${fresh.length} to session`,
      );
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Couldn't add participants",
      );
    } finally {
      setAddMode(null);
    }
  };

  const handleChangeModel = (actorId: string) => {
    const runtime = findRuntimeForAgent(actorId);
    if (!runtime) {
      showToast(
        "error",
        "This agent's runtime isn't online — wait for it to reconnect.",
      );
      return;
    }
    setModelPromptAgent(runtime);
  };

  const handleRestart = (actorId: string) => {
    const runtime = findRuntimeForAgent(actorId);
    if (!runtime) {
      showToast(
        "error",
        "This agent's runtime isn't online — wait for it to reconnect.",
      );
      return;
    }
    const actor = actors.find((candidate) => candidate.actorId === actorId);
    if (!actor || !isAgentActor(actor)) {
      showToast("error", "Couldn't resolve this agent.");
      return;
    }
    const currentMemberActorId = state.currentMemberActorId;
    if (!sessionId || !teamId || !currentMemberActorId) {
      showToast("error", "Session or member identity is not ready.");
      return;
    }
    if (!teamMqtt) {
      showToast("error", "MQTT is not connected — wait for Teamclaw to reconnect.");
      return;
    }

    void (async () => {
      try {
        await connectedAgentsStore?.reload();
        const plan = resolveAgentRuntimeRestartPlan({
          agent: {
            actorId: actor.actorId,
            displayName: actor.displayName,
            agentTypes: actor.agentTypes,
            defaultAgentType: actor.defaultAgentType,
            defaultWorkspaceId: actor.defaultWorkspaceId ?? null,
          },
          runtime: {
            agentId: runtime.agentId,
            runtimeId: runtime.runtimeId,
            workspaceId: runtime.workspaceId,
            backendType: runtime.backendType,
          },
          connectedAgents:
            connectedAgentsStore?.getState().agents.map((agent) => ({
              agentId: agent.agentId,
            })) ?? [],
          workspaces: workspaces.map((workspace) => ({
            id: workspace.id,
            path: workspace.path ?? "",
            agentId: workspace.agent_id,
          })),
        });
        const runtimeRpc = createRuntimeRpcClient({
          mqtt: teamMqtt,
          teamId,
          requesterActorId: currentMemberActorId,
        });

        if (plan.runtimeIdToStop) {
          await runtimeRpc.runtimeStop({
            targetActorId: plan.targetActorId,
            runtimeId: plan.runtimeIdToStop,
          }).catch(() => {
            // Stop is best-effort; a stale runtime id should not block the fresh start.
          });
        }

        const result = await runtimeRpc.runtimeStart({
          targetActorId: plan.targetActorId,
          workspaceId: plan.workspaceId,
          worktree: plan.worktree,
          sessionId,
          agentType: plan.agentType,
          initialPrompt: "",
        });
        setRuntimes((prev) =>
          prev.map((row) =>
            row.agentId === actorId
              ? {
                  ...row,
                  runtimeId: result.runtimeId || row.runtimeId,
                  status: "starting",
                }
              : row,
          ),
        );
        showToast("success", "Runtime restart requested");
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't restart runtime",
        );
      }
    })();
  };

  return (
    <>
      <SessionMemberSheet
        actors={participants}
        agentModelByActorId={agentModelByActorId}
        currentActorId={state.currentMemberActorId ?? null}
        isLoading={isLoading}
        onAddAgent={() => setAddMode("agents")}
        onAddMember={() => setAddMode("members")}
        onChangeAgentModel={handleChangeModel}
        onClose={() => router.back()}
        onRemoveActor={handleRemove}
        onRestartAgentRuntime={handleRestart}
      />
      <Modal
        animationType="slide"
        onRequestClose={() => setAddMode(null)}
        presentationStyle="pageSheet"
        visible={addMode !== null}
      >
        <MemberPickerSheet
          actors={pickerCandidates}
          excludeActorIds={participantIds}
          onCancel={() => setAddMode(null)}
          onConfirm={handleAdd}
        />
      </Modal>
      <TextPromptModal
        confirmLabel="Update"
        description="Set the model the runtime uses for the next turn (e.g. claude-sonnet-4-6)."
        initialValue={modelPromptAgent?.currentModel ?? ""}
        isVisible={modelPromptAgent !== null}
        onCancel={() => setModelPromptAgent(null)}
        onSubmit={async (next) => {
          const target = modelPromptAgent;
          const trimmed = next.trim();
          setModelPromptAgent(null);
          if (!target || !trimmed) return;
          try {
            await createConfiguredSessionsApi(supabase).updateRuntimeModel(
              target.dbRuntimeId,
              trimmed,
            );
            setRuntimes((prev) =>
              prev.map((row) =>
                row.dbRuntimeId === target.dbRuntimeId
                  ? { ...row, currentModel: trimmed }
                  : row,
              ),
            );
            showToast("success", `Model set to ${trimmed}`);
          } catch (err) {
            showToast(
              "error",
              err instanceof Error ? err.message : "Couldn't update model",
            );
          }
        }}
        placeholder="claude-sonnet-4-6"
        title="Change model"
      />
    </>
  );
}
