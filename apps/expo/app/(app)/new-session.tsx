import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";

import { useConnectedAgentsStore, useOnboarding, useTeamMqtt } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { isAgentActor, type Actor } from "../../src/features/actors/actor-types";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import { isOpenIdea, type Idea } from "../../src/features/ideas/idea-types";
import { createWorkspacesApi } from "../../src/features/workspaces/workspace-api";
import { buildFirstMessageWithIdea } from "../../src/features/sessions/idea-preface";
import { resolveInitialMessageMentionActorIds } from "../../src/features/sessions/session-mention-resolver";
import { resolveAgentRuntimeStartPlans } from "../../src/features/sessions/runtime-start";
import { createConfiguredSessionsApi } from "../../src/features/sessions/api-provider";
import {
  NewSessionScreen,
  type AgentWorkspaceChoice,
} from "../../src/features/sessions/screens/NewSessionScreen";
import { createRuntimeRpcClient } from "../../src/lib/teamclaw/runtime-rpc";
import { supabase } from "../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { uuidV4 } from "../../src/lib/uuid";
import { showToast } from "../../src/ui/Toast";

function deriveTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim();
  if (!trimmed) return "New session";
  const firstLine = trimmed.split(/\n/)[0] ?? trimmed;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

export default function NewSessionRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{ ideaId?: string }>();
  const ideaId = typeof params.ideaId === "string" ? params.ideaId : null;
  const { state } = useOnboarding();
  const teamMqtt = useTeamMqtt();
  const connectedAgentsStore = useConnectedAgentsStore();
  const [isBusy, setIsBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actors, setActors] = useState<Actor[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [workspaces, setWorkspaces] = useState<AgentWorkspaceChoice[]>([]);

  useEffect(() => {
    const teamId = state.currentTeam?.id;
    if (!teamId) return;
    let cancelled = false;
    void Promise.all([
      createActorsApi({ getAccessToken: supabaseAccessToken(supabase) }).listActors(teamId),
      createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) }).listIdeas(teamId),
      createWorkspacesApi({ getAccessToken: supabaseAccessToken(supabase) }).list(teamId),
    ])
      .then(([actorRows, ideaRows, workspaceRows]) => {
        if (cancelled) return;
        setActors(actorRows);
        setIdeas(ideaRows.filter(isOpenIdea));
        setWorkspaces(
          workspaceRows
            .filter((row) => !row.archived)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((row) => ({
              id: row.id,
              path: row.path ?? "",
              agentId: row.agentId,
            })),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setActors([]);
        setIdeas([]);
        setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [state.currentTeam?.id]);

  useEffect(() => {
    void connectedAgentsStore?.reload();
  }, [connectedAgentsStore]);

  const ideaChoices = useMemo(
    () =>
      ideas.map((idea) => ({
        ideaId: idea.ideaId,
        displayTitle: idea.title.trim() || "Untitled idea",
      })),
    [ideas],
  );

  return (
    <NewSessionScreen
      actors={actors}
      currentMemberActorId={state.currentMemberActorId}
      errorMessage={errorMessage}
      ideas={ideaChoices}
      isBusy={isBusy}
      selectedIdeaId={ideaId}
      workspaces={workspaces}
      onClose={() => router.back()}
      onCreate={async ({
        firstMessage,
        collaboratorActorIds,
        primaryAgentActorId,
        agentConfig,
        ideaId: chosenIdeaId,
      }) => {
        if (!state.currentTeam) {
          setErrorMessage("No active team — bootstrap first.");
          return;
        }
        const memberActorId = state.currentMemberActorId;
        if (!memberActorId) {
          setErrorMessage("Couldn't resolve your member identity in this team.");
          return;
        }

        setIsBusy(true);
        setErrorMessage(null);
        try {
          const sessionsApi = createConfiguredSessionsApi(supabase);
          const actorById = new Map(actors.map((actor) => [actor.actorId, actor]));
          const selectedAgents = collaboratorActorIds
            .map((id) => actorById.get(id))
            .filter((actor): actor is Actor => Boolean(actor && isAgentActor(actor)));
          if (selectedAgents.length > 0 && !connectedAgentsStore) {
            throw new Error("Connected agents are not ready — wait for Teamclaw to reconnect.");
          }
          if (selectedAgents.length > 0) {
            await connectedAgentsStore?.reload();
          }
          const runtimePlans =
            selectedAgents.length > 0
              ? resolveAgentRuntimeStartPlans({
                  agents: selectedAgents.map((actor) => ({
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
                  explicitSelection: agentConfig,
                  workspaces: workspaces.map((workspace) => ({
                    id: workspace.id,
                    path: workspace.path,
                    agentId: workspace.agentId ?? null,
                  })),
                })
              : [];

          if (runtimePlans.length > 0 && !teamMqtt) {
            throw new Error("MQTT is not connected — wait for Teamclaw to reconnect.");
          }

          const idea = chosenIdeaId
            ? ideas.find((row) => row.ideaId === chosenIdeaId)
            : undefined;
          const expandedMessage = buildFirstMessageWithIdea(firstMessage, idea);
          const sessionId = await sessionsApi.createSession({
            teamId: state.currentTeam.id,
            title: deriveTitle(firstMessage),
            mode: "collab",
            primaryAgentId: primaryAgentActorId,
            ideaId: chosenIdeaId,
          });

          // create_session seeds session_participants with the caller and the
          // primary agent. Add any other picked collaborators (extra agents,
          // humans) on top.
          const extras = collaboratorActorIds.filter(
            (id) => id !== primaryAgentActorId && id !== memberActorId,
          );
          if (extras.length > 0) {
            await sessionsApi.addParticipants(sessionId, extras);
          }

          if (expandedMessage.trim().length > 0) {
            const mentionActorIds = resolveInitialMessageMentionActorIds({
              collaboratorActorIds,
              teamActors: actors,
            });
            await sessionsApi.insertOutgoingMessage({
              id: uuidV4(),
              teamId: state.currentTeam.id,
              sessionId,
              senderActorId: memberActorId,
              content: expandedMessage.trim(),
              metadata: { mention_actor_ids: mentionActorIds },
            });
          }

          if (runtimePlans.length > 0 && teamMqtt) {
            const runtimeRpc = createRuntimeRpcClient({
              mqtt: teamMqtt,
              teamId: state.currentTeam.id,
              requesterActorId: memberActorId,
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

          router.replace(`/(app)/sessions/${sessionId}`);
        } catch (error) {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Couldn't create the session — try again.",
          );
        } finally {
          setIsBusy(false);
        }
      }}
    />
  );
}
