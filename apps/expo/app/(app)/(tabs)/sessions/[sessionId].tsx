import { Redirect, Stack, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Share, StyleSheet, Text, View } from "react-native";

import { routeToHref, useConnectedAgentsStore, useOnboarding, useTeamMqtt } from "../../../_layout";
import { resolveSlashCommands } from "../../../../src/features/sessions/components/runtime-commands";
import { BUILT_IN_SLASH_COMMANDS } from "../../../../src/features/sessions/components/slash-commands";
import type { RuntimeInfo } from "../../../../src/features/actors/connected-agent-types";
import { createActorsApi } from "../../../../src/features/actors/actor-api";
import type { Actor } from "../../../../src/features/actors/actor-types";
import type { SessionMessage } from "../../../../src/features/sessions/session-types";
import {
  loadComposerDraft,
  saveComposerDraft,
} from "../../../../src/features/sessions/composer-drafts";
import type { AgentChip } from "../../../../src/features/sessions/components/AgentChipBar";
import { createOutboxDao } from "../../../../src/features/sessions/outbox-db";
import { createOutboxSender } from "../../../../src/features/sessions/outbox-sender";
import type { OutboxSqliteDb } from "../../../../src/features/sessions/outbox-db";
import { publishOutboxRowViaOptionalMqtt } from "../../../../src/features/sessions/session-outbox-publish";
import { resetOutbox, syncOutboxFromDao } from "../../../../src/features/sessions/outbox-store";
import { createConfiguredSessionsApi } from "../../../../src/features/sessions/api-provider";
import { createSessionDetailController } from "../../../../src/features/sessions/session-detail-controller";
import { emptyTimelineState } from "../../../../src/features/sessions/timeline-reducer";
import { createSessionDetailCache } from "../../../../src/features/sessions/session-detail-cache";
import { createSessionMutesApi } from "../../../../src/features/sessions/session-mutes";
import { supabaseAccessToken } from "../../../../src/lib/cloud-api/client";
import { SessionDetailScreen } from "../../../../src/features/sessions/screens/SessionDetailScreen";
import { impactLight, selectionTick, successTone } from "../../../../src/lib/haptics";
import { showToast } from "../../../../src/ui/Toast";
import { supabase } from "../../../../src/lib/supabase/client";
import { getDb } from "../../../../src/lib/db/sqlite";
import { getOptionalMqttUrl } from "../../../../src/lib/mqtt/config";
import {
  createRuntimeCommandSender,
  resolvePermissionRuntimeTarget,
} from "../../../../src/lib/teamclaw/runtime-command";
import type { TeamMqttClient } from "../../../../src/lib/mqtt/team-mqtt";
import { PrimaryButton } from "../../../../src/ui/button";
import { AppCard } from "../../../../src/ui/card";
import { TextPromptModal } from "../../../../src/ui/TextPromptModal";
import { colors, spacing, typography } from "../../../../src/ui/theme";
import type { SessionDetailControllerState } from "../../../../src/features/sessions/session-detail-controller";

const fallbackDetailState: SessionDetailControllerState = {
  status: "loading",
  session: null,
  messages: [],
  errorMessage: null,
  connectionState: "disconnected",
  composerText: "",
  isSending: false,
  isRefreshing: false,
  sendErrorMessage: null,
  replyTarget: null,
  streamingByAgent: emptyTimelineState().streamingByAgent,
};

type RouteRuntimeInfo = {
  dbRuntimeId: string;
  runtimeId: string;
  agentId: string | null;
  status: string;
  currentModel: string | null;
};

function canRenderSessionDetail(
  detailState: SessionDetailControllerState,
): detailState is SessionDetailControllerState & {
  status: "empty" | "ready" | "error";
  session: NonNullable<SessionDetailControllerState["session"]>;
} {
  return (
    detailState.session !== null &&
    (detailState.status === "empty" ||
      detailState.status === "ready" ||
      detailState.status === "error")
  );
}

export default function SessionDetailRoute() {
  const router = useRouter();
  const navigation = useNavigation();
  const { sessionId: rawSessionId } = useLocalSearchParams<{
    sessionId?: string | string[];
  }>();

  // Hide the parent Tabs bar while a session detail is on screen, matching
  // the iOS NavigationStack behavior. Restore on unmount so the bar comes
  // back when the user pops back to the list.
  useEffect(() => {
    const parent = navigation.getParent();
    if (!parent) return;
    parent.setOptions({ tabBarStyle: { display: "none" } });
    return () => {
      parent.setOptions({ tabBarStyle: undefined });
    };
  }, [navigation]);
  const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
  const { state } = useOnboarding();
  const teamMqtt = useTeamMqtt();
  const currentTeam = state.currentTeam;
  const href = routeToHref(state.route);
  const [controller, setController] = useState<ReturnType<typeof createSessionDetailController> | null>(
    null,
  );

  // Durable outbox: DAO + sender live here at the route so they survive
  // across controller rebuilds and we can call sender.retry() from UI.
  type OutboxHandle = { dao: ReturnType<typeof createOutboxDao>; sender: ReturnType<typeof createOutboxSender> };
  const outboxRef = useRef<OutboxHandle | null>(null);
  const teamActorsRef = useRef<Actor[]>([]);
  // Tracks message ids sent in this session so onChange can sync them.
  const recentMessageIdsRef = useRef<Set<string>>(new Set());

  const handleBackToList = () => {
    router.replace("/(app)/sessions");
  };

  useEffect(() => {
    if (state.route !== "ready" || !sessionId || currentTeam === null) {
      setController(null);
      return;
    }

    // Best-effort mark-as-read: surfaces the session as no-longer-unread the
    // next time the list reloads. Failures are silent — the list re-derives
    // unread state from the (unchanged) read marker anyway.
    if (state.currentMemberActorId) {
      void createConfiguredSessionsApi(supabase).markSessionRead(
        sessionId,
        state.currentMemberActorId,
        null,
      );
    }

    let cancelled = false;
    // Capture the shared team MQTT client for the outbox sender's send closure.
    // teamMqtt may be null while the root layout is still connecting; in that
    // case the outbox send rejects so the row stays pending and retries after
    // the route rebuilds with a live MQTT adapter.
    const mqttSnapshot = teamMqtt;

    void (async () => {
      // Build the outbox before the controller so load() has it available
      // on the very first call.
      const db = await getDb();
      if (cancelled) return;

      const dao = createOutboxDao(db as unknown as OutboxSqliteDb);
      const sender = createOutboxSender({
        dao,
        send: (row) => {
          // Track this id so onChange can sync its status from the DAO.
          recentMessageIdsRef.current.add(row.messageId);
          return publishOutboxRowViaOptionalMqtt(row, mqttSnapshot);
        },
        onChange: () => {
          void syncOutboxFromDao(dao, Array.from(recentMessageIdsRef.current));
        },
      });
      outboxRef.current = { dao, sender };

      const noOpMqtt: Pick<TeamMqttClient, "subscribe" | "publish" | "onConnectionState"> = {
        subscribe: () => () => {},
        publish: async () => {},
        onConnectionState: () => () => {},
      };

      const nextController = createSessionDetailController({
        api: createConfiguredSessionsApi(supabase),
        cache: createSessionDetailCache(),
        currentMemberActorId: state.currentMemberActorId,
        getAuth: async () => {
          const { data } = await supabase.auth.getSession();
          return {
            accessToken: data.session?.access_token ?? null,
            userId: data.session?.user.id ?? null,
          };
        },
        getTeamActors: () => teamActorsRef.current,
        mqtt: mqttSnapshot ?? noOpMqtt,
        mqttUrl: getOptionalMqttUrl(),
        outbox: { dao, sender },
        sessionId,
        teamId: currentTeam.id,
      });

      if (cancelled) {
        void nextController.dispose();
        return;
      }

      setController(nextController);
      await nextController.load();

      // Restore any composer draft saved for this session on a prior visit.
      const draft = await loadComposerDraft(sessionId);
      if (!cancelled && draft.length > 0) {
        nextController.setComposerText(draft);
      }
    })();

    return () => {
      cancelled = true;
      outboxRef.current?.sender.stop();
      outboxRef.current = null;
      recentMessageIdsRef.current = new Set();
      void controller?.dispose();
      resetOutbox();
    };
  }, [currentTeam, sessionId, state.currentMemberActorId, state.route, teamMqtt]);

  // Persist composer text per-session as it changes (debounced via ref).
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    };
  }, []);

  if (state.route !== "ready") {
    return <Redirect href={href ?? "/"} />;
  }

  if (!sessionId || currentTeam === null) {
    return <Redirect href="/(app)/sessions" />;
  }

  const detailState = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getState ?? (() => fallbackDetailState),
    controller?.getState ?? (() => fallbackDetailState),
  );

  const connectedAgentsStore = useConnectedAgentsStore();
  const emptyAgentsState = useMemo(() => ({
    agents: [],
    runtimeInfoByAgentId: new Map() as ReadonlyMap<string, RuntimeInfo>,
    isLoading: false,
    errorMessage: null,
  }), []);
  const agentsState = useSyncExternalStore(
    (listener) => connectedAgentsStore?.subscribe(listener) ?? (() => {}),
    () => connectedAgentsStore?.getState() ?? emptyAgentsState,
    () => connectedAgentsStore?.getState() ?? emptyAgentsState,
  );

  const dynamicSlashCommands = useMemo(() => {
    const session = detailState.session;
    if (!session) return [...BUILT_IN_SLASH_COMMANDS];
    const runtimeInfos = session.participantActorIds
      .map((id) => agentsState.runtimeInfoByAgentId.get(id))
      .filter((r): r is RuntimeInfo => r != null);
    return resolveSlashCommands(runtimeInfos, BUILT_IN_SLASH_COMMANDS);
  }, [detailState.session, agentsState.runtimeInfoByAgentId]);

  const [teamActors, setTeamActors] = useState<Actor[]>([]);
  const [runtimeInfo, setRuntimeInfo] = useState<RouteRuntimeInfo | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isModelPromptOpen, setIsModelPromptOpen] = useState(false);
  const [editingMessage, setEditingMessage] = useState<
    { messageId: string; content: string } | null
  >(null);
  const [resolvedPermissions, setResolvedPermissions] = useState<
    ReadonlyMap<string, boolean>
  >(new Map());
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    teamActorsRef.current = teamActors;
  }, [teamActors]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user.id ?? null;
      if (cancelled) return;
      userIdRef.current = uid;
      const mutes = createSessionMutesApi({ getAccessToken: supabaseAccessToken(supabase) });
      try {
        const muted = await mutes.isMuted(sessionId);
        if (!cancelled) setIsMuted(muted);
      } catch {
        if (!cancelled) setIsMuted(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void createConfiguredSessionsApi(supabase)
      .loadRuntime(sessionId)
      .then((row) => {
        if (cancelled) return;
        setRuntimeInfo(
          row
            ? {
                dbRuntimeId: row.dbRuntimeId,
                runtimeId: row.runtimeId,
                agentId: row.agentId,
                status: row.status,
                currentModel: row.currentModel,
              }
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setRuntimeInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  useEffect(() => {
    if (!currentTeam?.id) return;
    let cancelled = false;
    void createActorsApi({ getAccessToken: supabaseAccessToken(supabase) })
      .listActors(currentTeam.id)
      .then((rows) => {
        if (!cancelled) setTeamActors(rows);
      })
      .catch(() => {
        if (!cancelled) setTeamActors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentTeam?.id]);

  const streamingAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const buffer of detailState.streamingByAgent.values()) {
      if (!buffer.isComplete) {
        ids.add(buffer.senderActorId);
      }
    }
    return ids;
  }, [detailState.streamingByAgent]);

  const agentChips: AgentChip[] = useMemo(() => {
    if (!detailState.session) return [];
    const participantIds = new Set(detailState.session.participantActorIds);
    return teamActors
      .filter((actor) => actor.actorType === "agent" && participantIds.has(actor.actorId))
      .map((actor) => ({
        agentId: actor.actorId,
        displayName: actor.displayName,
        runtimeState: streamingAgentIds.has(actor.actorId)
          ? "active" as const
          : "ready" as const,
      }));
  }, [detailState.session, streamingAgentIds, teamActors]);

  const agentParticipantIds = useMemo(() => {
    if (!detailState.session) return [];
    const participantIds = new Set(detailState.session.participantActorIds);
    const ids = new Set<string>();
    for (const actor of teamActors) {
      if (actor.actorType === "agent" && participantIds.has(actor.actorId)) {
        ids.add(actor.actorId);
      }
    }
    for (const agent of agentsState.agents) {
      if (participantIds.has(agent.agentId)) {
        ids.add(agent.agentId);
      }
    }
    return Array.from(ids);
  }, [agentsState.agents, detailState.session, teamActors]);

  const mentionPool = useMemo(
    () =>
      teamActors.map((actor) => ({
        actorId: actor.actorId,
        displayName: actor.displayName,
      })),
    [teamActors],
  );

  const senderNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const actor of teamActors) {
      map.set(actor.actorId, actor.displayName);
    }
    return map;
  }, [teamActors]);

  const senderAvatars = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const actor of teamActors) {
      map.set(actor.actorId, actor.avatarUrl);
    }
    return map;
  }, [teamActors]);

  const senderAvatarGlyphs = useMemo(() => {
    const map = new Map<string, string>();
    for (const actor of teamActors) {
      if (actor.actorType !== "agent") continue;
      switch (actor.agentKind) {
        case "claude":
          map.set(actor.actorId, "CC");
          break;
        case "opencode":
          map.set(actor.actorId, "OC");
          break;
        case "codex":
          map.set(actor.actorId, "CX");
          break;
        default:
          break;
      }
    }
    return map;
  }, [teamActors]);

  const headerAvatars = useMemo(() => {
    if (!detailState.session) return [];
    const participantIds = new Set(detailState.session.participantActorIds);
    return teamActors
      .filter((actor) => participantIds.has(actor.actorId))
      .slice(0, 3)
      .map((actor) => {
        let initial = actor.displayName.charAt(0).toUpperCase() || "?";
        if (actor.actorType === "agent") {
          switch (actor.agentKind) {
            case "claude":
              initial = "CC";
              break;
            case "opencode":
              initial = "OC";
              break;
            case "codex":
              initial = "CX";
              break;
            default:
              break;
          }
        }
        return {
          actorId: actor.actorId,
          avatarUrl: actor.avatarUrl,
          initial,
        };
      });
  }, [detailState.session, teamActors]);

  const permissionCommandSender = useMemo(() => {
    if (!teamMqtt || !currentTeam?.id || !state.currentMemberActorId) return null;
    return createRuntimeCommandSender({
      mqtt: teamMqtt,
      teamId: currentTeam.id,
      peerId: `teamclaw-expo-${state.currentMemberActorId.slice(0, 8)}`,
      senderActorId: state.currentMemberActorId,
    });
  }, [currentTeam?.id, state.currentMemberActorId, teamMqtt]);

  const handlePermissionResponse = async (
    requestId: string,
    message: SessionMessage,
    granted: boolean,
  ) => {
    if (!permissionCommandSender) {
      showToast("error", "移动端 MQTT 未连接，重连后再试。");
      return;
    }

    const fallbackAgentIds =
      agentParticipantIds.length > 0
        ? agentParticipantIds
        : [message.senderActorId, runtimeInfo?.agentId ?? ""].filter(Boolean);
    const target = resolvePermissionRuntimeTarget({
      requestingActorId: message.senderActorId,
      agentParticipantIds: fallbackAgentIds,
      connectedAgents: agentsState.agents,
      runtimeInfoByAgentId: agentsState.runtimeInfoByAgentId,
      fallbackRuntime: runtimeInfo
        ? { agentId: runtimeInfo.agentId, runtimeId: runtimeInfo.runtimeId }
        : null,
    });

    if (!target) {
      showToast("error", "还没定位到这个 agent runtime，请等 agent 在线后重试。");
      return;
    }

    try {
      await permissionCommandSender.sendPermissionResponse({
        targetActorId: target.actorId,
        runtimeId: target.runtimeId,
        requestId,
        granted,
      });
      setResolvedPermissions((prev) => {
        const next = new Map(prev);
        next.set(requestId, granted);
        return next;
      });
      selectionTick();
      showToast("success", granted ? "Permission allowed" : "Permission denied");
    } catch (err) {
      showToast(
        "error",
        err instanceof Error ? err.message : "Permission response failed",
      );
    }
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "会话详情" }} />
      {detailState.status === "loading" ? (
        <View style={styles.cardContainer}>
          <AppCard elevated style={styles.card}>
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.faint} />
              <Text style={styles.cardTitle}>加载会话中</Text>
            </View>
            <Text style={styles.body}>正在准备这个会话的详情壳子。</Text>
          </AppCard>
        </View>
      ) : null}

      {detailState.status === "error" && !canRenderSessionDetail(detailState) ? (
        <View style={styles.cardContainer}>
          <AppCard elevated style={styles.card}>
            <Text style={styles.cardTitle}>无法打开会话</Text>
            <Text style={styles.body}>{detailState.errorMessage}</Text>
            <PrimaryButton
              fullWidth={false}
              label="返回会话列表"
              onPress={handleBackToList}
            />
          </AppCard>
        </View>
      ) : null}

      {detailState.status === "not-found" ? (
        <View style={styles.cardContainer}>
          <AppCard elevated style={styles.card}>
            <Text style={styles.cardTitle}>未找到会话</Text>
            <Text style={styles.body}>这个会话可能已被删除，或者你当前没有访问权限。</Text>
            <PrimaryButton
              fullWidth={false}
              label="返回会话列表"
              onPress={handleBackToList}
            />
          </AppCard>
        </View>
      ) : null}

      {canRenderSessionDetail(detailState) ? (
        <SessionDetailScreen
          agentChips={agentChips}
          composerText={detailState.composerText}
          connectionState={detailState.connectionState}
          headerAvatars={headerAvatars}
          isSending={detailState.isSending}
          isRefreshing={detailState.isRefreshing}
          mentionPool={mentionPool}
          onAttach={() => {
            router.push(`/(app)/attach?sessionId=${sessionId}`);
          }}
          onGrantPermission={(requestId, message) => {
            void handlePermissionResponse(requestId, message, true);
          }}
          onDenyPermission={(requestId, message) => {
            void handlePermissionResponse(requestId, message, false);
          }}
          resolvedPermissionsByRequestId={resolvedPermissions}
          onBack={handleBackToList}
          onChangeComposerText={(value) => {
            controller?.setComposerText(value);
            if (sessionId) {
              if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
              draftSaveTimer.current = setTimeout(() => {
                void saveComposerDraft(sessionId, value);
              }, 250);
            }
          }}
          onChangeRuntimeModel={
            runtimeInfo ? () => setIsModelPromptOpen(true) : undefined
          }
          onClearReply={() => controller?.setReplyTarget(null)}
          onDeleteMessage={async (messageId) => {
            try {
              await createConfiguredSessionsApi(supabase).deleteMessage(messageId);
              successTone();
              showToast("success", "Message deleted");
              void controller?.load();
            } catch (err) {
              showToast(
                "error",
                err instanceof Error ? err.message : "Couldn't delete message",
              );
            }
          }}
          onEditMessage={(messageId, currentContent) => {
            setEditingMessage({ messageId, content: currentContent });
          }}
          onOpenMembers={() => {
            router.push(`/(app)/session-members?sessionId=${sessionId}`);
          }}
          onReconnect={() => {
            void controller?.load();
          }}
          onRefresh={() => {
            void controller?.load({ preserveExisting: true });
          }}
          onReplyToMessage={(messageId) => {
            selectionTick();
            const target = detailState.messages.find((m) => m.messageId === messageId);
            if (target) {
              controller?.setReplyTarget({
                messageId: target.messageId,
                content: target.content,
              });
            }
          }}
          onRetryFailed={(messageId) => {
            const handle = outboxRef.current;
            if (!handle) return;
            recentMessageIdsRef.current.add(messageId);
            void handle.sender.retry(messageId).then(() => {
              void syncOutboxFromDao(
                handle.dao,
                Array.from(recentMessageIdsRef.current),
              );
            });
          }}
          onSend={() => {
            impactLight();
            if (sessionId) {
              void saveComposerDraft(sessionId, "");
            }
            void controller?.sendMessage();
          }}
          onShare={
            sessionId
              ? async () => {
                  const session = detailState.session;
                  const title = session?.title?.trim() ?? "Teamclaw session";
                  const url = `teamclaw://session/${sessionId}`;
                  try {
                    await Share.share({ message: `${title}\n${url}`, url });
                  } catch {
                    // user cancelled or platform refused
                  }
                }
              : undefined
          }
          isMuted={isMuted}
          onToggleMute={
            sessionId
              ? async () => {
                  const next = !isMuted;
                  setIsMuted(next);
                  selectionTick();
                  try {
                    await createSessionMutesApi({
                      getAccessToken: supabaseAccessToken(supabase),
                    }).setMuted(sessionId, next);
                    showToast("success", next ? "已静音" : "已取消静音");
                  } catch (err) {
                    setIsMuted(!next);
                    showToast(
                      "error",
                      err instanceof Error ? err.message : "无法切换静音",
                    );
                  }
                }
              : undefined
          }
          ownActorId={state.currentMemberActorId ?? undefined}
          replyTarget={detailState.replyTarget}
          runtimeInfo={runtimeInfo}
          senderAvatars={senderAvatars}
          senderAvatarGlyphs={senderAvatarGlyphs}
          senderNames={senderNames}
          sendErrorMessage={detailState.sendErrorMessage}
          slashCommands={dynamicSlashCommands}
          state={detailState}
          streamingAgentIds={streamingAgentIds}
        />
      ) : null}

      <TextPromptModal
        confirmLabel="Update"
        description="Set the model the runtime uses for the next turn (e.g. claude-sonnet-4-6)."
        initialValue={runtimeInfo?.currentModel ?? ""}
        isVisible={isModelPromptOpen && runtimeInfo !== null}
        onCancel={() => setIsModelPromptOpen(false)}
        onSubmit={async (next) => {
          const trimmed = next.trim();
          setIsModelPromptOpen(false);
          if (!trimmed || !runtimeInfo) return;
          try {
            await createConfiguredSessionsApi(supabase).updateRuntimeModel(
              runtimeInfo.dbRuntimeId,
              trimmed,
            );
            setRuntimeInfo({ ...runtimeInfo, currentModel: trimmed });
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

      <TextPromptModal
        confirmLabel="Save"
        initialValue={editingMessage?.content ?? ""}
        isVisible={editingMessage !== null}
        onCancel={() => setEditingMessage(null)}
        onSubmit={async (next) => {
          const trimmed = next.trim();
          const target = editingMessage;
          setEditingMessage(null);
          if (!target || !trimmed || trimmed === target.content.trim()) return;
          try {
            await createConfiguredSessionsApi(supabase).updateMessageContent(
              target.messageId,
              trimmed,
            );
            void controller?.load();
          } catch (err) {
            showToast(
              "error",
              err instanceof Error ? err.message : "Couldn't edit message",
            );
          }
        }}
        title="Edit message"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    color: colors.ink2,
    ...typography.secondaryBody,
  },
  card: {
    gap: spacing.md,
  },
  cardContainer: {
    padding: spacing.xxl,
  },
  cardTitle: {
    color: colors.foreground,
    ...typography.cardTitle,
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
});
