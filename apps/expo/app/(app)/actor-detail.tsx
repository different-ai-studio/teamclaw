import { useLocalSearchParams, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Share } from "react-native";

import { useOnboarding, useTeamMqtt } from "../_layout";
import { createActorsApi } from "../../src/features/actors/actor-api";
import { createAgentAccessApi } from "../../src/features/actors/agent-access-api";
import {
  canManageAuthorizedHumans,
  canRemoveActor,
} from "../../src/features/actors/actor-management";
import type { Actor } from "../../src/features/actors/actor-types";
import type { AgentAuthorizedHuman } from "../../src/features/actors/connected-agent-types";
import {
  ActorDetailScreen,
  type AgentWorkspaceChoice,
} from "../../src/features/actors/screens/ActorDetailScreen";
import { createWorkspacesApi } from "../../src/features/workspaces/workspace-api";
import { createConfiguredSessionsApi } from "../../src/features/sessions/api-provider";
import { createIdeasApi } from "../../src/features/ideas/idea-api";
import { supabase } from "../../src/lib/supabase/client";
import { supabaseAccessToken } from "../../src/lib/cloud-api/client";
import { createRuntimeRpcClient } from "../../src/lib/teamclaw/runtime-rpc";
import { showToast } from "../../src/ui/Toast";

type RecentSession = {
  sessionId: string;
  title: string;
  lastMessageAt: string;
};

export default function ActorDetailRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const teamMqtt = useTeamMqtt();
  const params = useLocalSearchParams<{ actorId?: string }>();
  const actorId = typeof params.actorId === "string" ? params.actorId : null;
  const teamId = state.currentTeam?.id ?? "";
  const isMe = actorId !== null && actorId === state.currentMemberActorId;

  const actorsApi = useMemo(
    () => createActorsApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );
  const agentAccessApi = useMemo(
    () => createAgentAccessApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );
  const workspacesApi = useMemo(
    () => createWorkspacesApi({ getAccessToken: supabaseAccessToken(supabase) }),
    [],
  );

  const [actor, setActor] = useState<Actor | null>(null);
  const [agentIsOwner, setAgentIsOwner] = useState(false);
  const [allActors, setAllActors] = useState<Actor[]>([]);
  const [agentWorkspaces, setAgentWorkspaces] = useState<AgentWorkspaceChoice[]>([]);
  const [authorizedHumans, setAuthorizedHumans] = useState<AgentAuthorizedHuman[]>([]);
  const [isCreatingReinvite, setIsCreatingReinvite] = useState(false);
  const [isAddingAgentWorkspace, setIsAddingAgentWorkspace] = useState(false);
  const [isGrantingAuthorizedHuman, setIsGrantingAuthorizedHuman] = useState(false);
  const [isLoadingAuthorizedHumans, setIsLoadingAuthorizedHumans] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isRevokingAuthorizedHuman, setIsRevokingAuthorizedHuman] = useState(false);
  const [isRemovingAgentWorkspace, setIsRemovingAgentWorkspace] = useState(false);
  const [isSavingAgentDefaults, setIsSavingAgentDefaults] = useState(false);
  const [isUpdatingAgentVisibility, setIsUpdatingAgentVisibility] = useState(false);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [stats, setStats] = useState<{ sessions: number; ideas: number } | null>(null);
  const canRemove = canRemoveActor({
    actorId,
    currentMemberActorId: state.currentMemberActorId,
    currentTeamRole: state.currentTeam?.role,
  });
  const canManageAccess = canManageAuthorizedHumans({
    actorType: actor?.actorType,
    isOwner: agentIsOwner,
  });
  const authorizedHumanIds = new Set(authorizedHumans.map((human) => human.id));
  const authorizedMemberCandidates = allActors.filter(
    (row) =>
      row.actorType === "member" &&
      row.actorId !== state.currentMemberActorId &&
      !authorizedHumanIds.has(row.actorId),
  );

  const reloadAgentWorkspaces = useCallback(async () => {
    if (!teamId) return;
    try {
      const rows = await workspacesApi.list(teamId);
      setAgentWorkspaces(
        rows
          .filter((w) => !w.archived)
          .map((w) => ({ id: w.id, name: w.name, path: w.path, agentId: w.agentId }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    } catch {
      setAgentWorkspaces([]);
    }
  }, [teamId, workspacesApi]);

  const refresh = useCallback(async () => {
    if (!teamId || !actorId) return;
    setIsRefreshing(true);
    try {
      const rows = await actorsApi.listActors(teamId);
      setAllActors(rows);
      const found = rows.find((row) => row.actorId === actorId) ?? null;
      if (found?.actorType === "agent") {
        // Directory drops owner; re-hydrate owner-gating from agent-access so it
        // survives a refresh. Daemon routing uses the actor id directly.
        const owner = state.currentMemberActorId
          ? await agentAccessApi
              .canManageAgent(actorId, state.currentMemberActorId)
              .catch(() => false)
          : false;
        setAgentIsOwner(owner);
        setActor(found);
      } else {
        setAgentIsOwner(false);
        setActor(found);
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [actorId, teamId, actorsApi, agentAccessApi, state.currentMemberActorId]);

  useEffect(() => {
    if (!teamId || !actorId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        const rows = await actorsApi.listActors(teamId);
        if (cancelled) return;
        const nextActor = rows.find((row) => row.actorId === actorId) ?? null;
        setAllActors(rows);
        setActor(nextActor);
        setAgentIsOwner(false);

        if (nextActor?.actorType === "agent") {
          setIsLoadingAuthorizedHumans(true);
          const [authorizedRows, owner, workspaceRows] = await Promise.all([
            agentAccessApi.listAuthorizedHumans(actorId),
            state.currentMemberActorId
              ? agentAccessApi
                  .canManageAgent(actorId, state.currentMemberActorId)
                  .catch(() => false)
              : Promise.resolve(false),
            workspacesApi.list(teamId).catch(() => []),
          ]);
          if (cancelled) return;
          setAuthorizedHumans(authorizedRows);
          setAgentIsOwner(owner);
          // Daemon routing uses the agent's actor id directly; no device-id merge.
          setAgentWorkspaces(
            workspaceRows
              .filter((w) => !w.archived)
              .map((w) => ({ id: w.id, name: w.name, path: w.path, agentId: w.agentId }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
          setIsLoadingAuthorizedHumans(false);
        } else {
          setAuthorizedHumans([]);
          setAgentWorkspaces([]);
        }

        const sessionIds = await actorsApi.listActorSessionIds(actorId);
        if (cancelled) return;
        const sessionIdSet = new Set(sessionIds);
        const teamSessions = teamId
          ? await createConfiguredSessionsApi(supabase).listSessions(teamId)
          : [];
        if (cancelled) return;
        const sessions = teamSessions
          .filter((s) => sessionIdSet.has(s.sessionId))
          .map((s) => ({
            sessionId: s.sessionId,
            title: s.title ?? "",
            lastMessageAt: s.lastMessageAt ?? "",
          }))
          .sort((a, b) => {
            const ams = Date.parse(a.lastMessageAt) || 0;
            const bms = Date.parse(b.lastMessageAt) || 0;
            return bms - ams;
          })
          .slice(0, 5);
        setRecentSessions(sessions);

        const ideas = teamId
          ? await createIdeasApi({ getAccessToken: supabaseAccessToken(supabase) }).listIdeas(teamId)
          : [];
        if (cancelled) return;
        setStats({
          sessions: sessionIds.length,
          ideas: ideas.filter((idea) => idea.createdByActorId === actorId).length,
        });
      } catch {
        if (!cancelled) {
          setActor(null);
          setAllActors([]);
          setAgentWorkspaces([]);
          setAuthorizedHumans([]);
          setRecentSessions([]);
          setStats(null);
        }
      } finally {
        if (!cancelled) setIsLoadingAuthorizedHumans(false);
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actorId, teamId, actorsApi, agentAccessApi, workspacesApi, state.currentMemberActorId]);

  const reloadAuthorizedHumans = useCallback(async () => {
    if (!actorId || actor?.actorType !== "agent") return;
    setIsLoadingAuthorizedHumans(true);
    try {
      const rows = await agentAccessApi.listAuthorizedHumans(actorId);
      setAuthorizedHumans(rows);
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Couldn't load authorized members.",
      );
    } finally {
      setIsLoadingAuthorizedHumans(false);
    }
  }, [actor?.actorType, actorId, agentAccessApi]);

  const removeActor = useCallback(() => {
    if (!actorId || !actor || isRemoving) return;
    Alert.alert(
      "Remove actor",
      `Remove ${actor.displayName} from this team?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            setIsRemoving(true);
            void actorsApi
              .removeActor(actorId)
              .then(() => {
                showToast("success", "Actor removed from team.");
                router.back();
              })
              .catch((err) => {
                showToast(
                  "error",
                  err instanceof Error ? err.message : "Couldn't remove actor.",
                );
              })
              .finally(() => {
                setIsRemoving(false);
              });
          },
        },
      ],
    );
  }, [actor, actorId, actorsApi, isRemoving, router]);

  const createReinvite = useCallback(async () => {
    if (!teamId || !actor || isCreatingReinvite) return;
    setIsCreatingReinvite(true);
    try {
      const invite = await actorsApi.createReinvite({ teamId, actor });
      await Clipboard.setStringAsync(invite.deeplink);
      showToast("success", "Invite link copied.");
      await Share.share({ message: invite.deeplink });
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Couldn't create invite link.",
      );
    } finally {
      setIsCreatingReinvite(false);
    }
  }, [actor, actorsApi, isCreatingReinvite, teamId]);

  const grantAuthorizedHuman = useCallback(
    async (memberActorId: string) => {
      if (!actorId || !state.currentMemberActorId || isGrantingAuthorizedHuman) return;
      setIsGrantingAuthorizedHuman(true);
      try {
        await agentAccessApi.grantAuthorizedHuman(
          actorId,
          memberActorId,
          "prompt",
          state.currentMemberActorId,
        );
        showToast("success", "Member authorized.");
        await reloadAuthorizedHumans();
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't authorize member.",
        );
      } finally {
        setIsGrantingAuthorizedHuman(false);
      }
    },
    [
      actorId,
      agentAccessApi,
      isGrantingAuthorizedHuman,
      reloadAuthorizedHumans,
      state.currentMemberActorId,
    ],
  );

  const revokeAuthorizedHuman = useCallback(
    async (memberActorId: string) => {
      if (!actorId || isRevokingAuthorizedHuman) return;
      setIsRevokingAuthorizedHuman(true);
      try {
        await agentAccessApi.revokeAuthorizedHuman(actorId, memberActorId);
        showToast("success", "Member access revoked.");
        await reloadAuthorizedHumans();
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't revoke member access.",
        );
      } finally {
        setIsRevokingAuthorizedHuman(false);
      }
    },
    [actorId, agentAccessApi, isRevokingAuthorizedHuman, reloadAuthorizedHumans],
  );

  const updateAgentDefaults = useCallback(
    async (patch: { defaultWorkspaceId?: string | null; defaultAgentType?: string | null }) => {
      if (!actorId || !actor || isSavingAgentDefaults) return;
      setIsSavingAgentDefaults(true);
      try {
        await actorsApi.updateAgentDefaults(actorId, patch);
        setActor((prev) =>
          prev?.actorId === actorId
            ? {
                ...prev,
                defaultWorkspaceId:
                  patch.defaultWorkspaceId === undefined
                    ? prev.defaultWorkspaceId
                    : patch.defaultWorkspaceId,
                defaultAgentType:
                  patch.defaultAgentType === undefined
                    ? prev.defaultAgentType
                    : patch.defaultAgentType,
                agentKind:
                  patch.defaultAgentType === undefined
                    ? prev.agentKind
                    : patch.defaultAgentType,
              }
            : prev,
        );
        showToast("success", "Agent defaults saved.");
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't save agent defaults.",
        );
      } finally {
        setIsSavingAgentDefaults(false);
      }
    },
    [actor, actorId, actorsApi, isSavingAgentDefaults],
  );

  const addAgentWorkspace = useCallback(
    async (path: string) => {
      if (actor?.actorType !== "agent" || !actor?.actorId || !teamMqtt || !teamId || !state.currentMemberActorId) {
        showToast("error", "Daemon routing is unavailable.");
        return;
      }
      if (isAddingAgentWorkspace) return;
      setIsAddingAgentWorkspace(true);
      try {
        const rpc = createRuntimeRpcClient({
          mqtt: teamMqtt,
          teamId,
          requesterActorId: state.currentMemberActorId,
        });
        await rpc.addWorkspace({
          targetActorId: actor.actorId,
          path,
          timeoutMs: 25_000,
        });
        showToast("success", "Workspace add requested.");
        await Promise.all([refresh(), reloadAgentWorkspaces()]);
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't add workspace.",
        );
      } finally {
        setIsAddingAgentWorkspace(false);
      }
    },
    [
      actor?.actorType,
      actor?.actorId,
      isAddingAgentWorkspace,
      reloadAgentWorkspaces,
      refresh,
      state.currentMemberActorId,
      teamId,
      teamMqtt,
    ],
  );

  const removeAgentWorkspace = useCallback(
    async (workspaceId: string) => {
      if (actor?.actorType !== "agent" || !actor?.actorId || !teamMqtt || !teamId || !state.currentMemberActorId) {
        showToast("error", "Daemon routing is unavailable.");
        return;
      }
      if (isRemovingAgentWorkspace) return;
      setIsRemovingAgentWorkspace(true);
      try {
        const rpc = createRuntimeRpcClient({
          mqtt: teamMqtt,
          teamId,
          requesterActorId: state.currentMemberActorId,
        });
        await rpc.removeWorkspace({
          targetActorId: actor.actorId,
          workspaceId,
          timeoutMs: 25_000,
        });
        showToast("success", "Workspace remove requested.");
        await Promise.all([refresh(), reloadAgentWorkspaces()]);
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't remove workspace.",
        );
      } finally {
        setIsRemovingAgentWorkspace(false);
      }
    },
    [
      actor?.actorType,
      actor?.actorId,
      isRemovingAgentWorkspace,
      reloadAgentWorkspaces,
      refresh,
      state.currentMemberActorId,
      teamId,
      teamMqtt,
    ],
  );

  const updateAgentVisibility = useCallback(
    async (visibility: "team" | "personal") => {
      if (!actorId || !actor || isUpdatingAgentVisibility) return;
      setIsUpdatingAgentVisibility(true);
      try {
        if (visibility === "team") {
          await agentAccessApi.shareAgentToTeam(actorId);
        } else {
          await agentAccessApi.makeAgentPersonal(actorId);
        }
        setActor((prev) => (prev?.actorId === actorId ? { ...prev, visibility } : prev));
        showToast(
          "success",
          visibility === "team" ? "Agent shared to team." : "Agent made personal.",
        );
        await refresh();
      } catch (err) {
        showToast(
          "error",
          err instanceof Error ? err.message : "Couldn't update agent visibility.",
        );
      } finally {
        setIsUpdatingAgentVisibility(false);
      }
    },
    [actor, actorId, agentAccessApi, isUpdatingAgentVisibility, refresh],
  );

  return (
    <ActorDetailScreen
      actor={actor}
      agentWorkspaces={agentWorkspaces}
      authorizedHumans={authorizedHumans}
      authorizedMemberCandidates={authorizedMemberCandidates}
      isLoading={isLoading}
      isAddingAgentWorkspace={isAddingAgentWorkspace}
      isCreatingReinvite={isCreatingReinvite}
      isGrantingAuthorizedHuman={isGrantingAuthorizedHuman}
      isLoadingAuthorizedHumans={isLoadingAuthorizedHumans}
      isMe={isMe}
      isRefreshing={isRefreshing}
      isRemoving={isRemoving}
      isRemovingAgentWorkspace={isRemovingAgentWorkspace}
      isRevokingAuthorizedHuman={isRevokingAuthorizedHuman}
      isSavingAgentDefaults={isSavingAgentDefaults}
      isUpdatingAgentVisibility={isUpdatingAgentVisibility}
      onClose={() => router.back()}
      onAddAgentWorkspace={canManageAccess ? addAgentWorkspace : undefined}
      onCreateReinvite={canRemove ? createReinvite : undefined}
      onGrantAuthorizedHuman={canManageAccess ? grantAuthorizedHuman : undefined}
      onMakeAgentPersonal={
        canManageAccess && actor?.visibility !== "personal"
          ? () => void updateAgentVisibility("personal")
          : undefined
      }
      onRefresh={() => {
        void Promise.all([refresh(), reloadAuthorizedHumans()]);
      }}
      onRemoveActor={canRemove ? removeActor : undefined}
      onRemoveAgentWorkspace={canManageAccess ? removeAgentWorkspace : undefined}
      onRevokeAuthorizedHuman={canManageAccess ? revokeAuthorizedHuman : undefined}
      onSelectSession={(sessionId) => {
        router.replace(`/(app)/sessions/${sessionId}`);
      }}
      onShareAgentToTeam={
        canManageAccess && actor?.visibility === "personal"
          ? () => void updateAgentVisibility("team")
          : undefined
      }
      onUpdateAgentDefaults={actor?.actorType === "agent" ? updateAgentDefaults : undefined}
      recentSessions={recentSessions}
      stats={stats ?? undefined}
    />
  );
}
