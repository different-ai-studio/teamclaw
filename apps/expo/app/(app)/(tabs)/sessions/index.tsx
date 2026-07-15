import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Modal } from "react-native";

import { routeToHref, useOnboarding } from "../../../_layout";
import { createActorsApi } from "../../../../src/features/actors/actor-api";
import { supabaseAccessToken } from "../../../../src/lib/cloud-api/client";
import {
  loadPinnedSessions,
  subscribePinnedSessions,
  togglePinnedSession,
} from "../../../../src/features/sessions/pinned-sessions";
import { successTone, selectionTick } from "../../../../src/lib/haptics";
import { createConfiguredSessionsApi } from "../../../../src/features/sessions/api-provider";
import { createSessionsCache } from "../../../../src/features/sessions/session-cache";
import { createSessionsController } from "../../../../src/features/sessions/session-controller";
import { SessionsListScreen } from "../../../../src/features/sessions/screens/SessionsListScreen";
import { ZeroAgentReminderSheet } from "../../../../src/features/sessions/screens/ZeroAgentReminderSheet";
import {
  hasShownZeroAgentReminder,
  markZeroAgentReminderShown,
} from "../../../../src/features/sessions/zero-agent-reminder-store";
import {
  ShortcutsDrawer,
  openShortcutTarget,
} from "../../../../src/features/shortcuts/ShortcutsDrawer";
import { supabase } from "../../../../src/lib/supabase/client";

export default function SessionsIndexRoute() {
  const router = useRouter();
  const { state } = useOnboarding();
  const href = routeToHref(state.route);
  const controllerRef = useRef<ReturnType<typeof createSessionsController> | null>(null);
  const teamIdRef = useRef<string | null>(null);
  const activeTeamId = state.currentTeam?.id ?? "";

  if (controllerRef.current === null || teamIdRef.current !== activeTeamId) {
    controllerRef.current = createSessionsController(
      createConfiguredSessionsApi(supabase),
      activeTeamId,
      state.currentMemberActorId,
      createSessionsCache(),
    );
    teamIdRef.current = activeTeamId;
  }

  const controller = controllerRef.current;
  const listState = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  useEffect(() => {
    if (!activeTeamId) {
      return;
    }

    void controller.load();
  }, [activeTeamId, controller]);

  useFocusEffect(
    useCallback(() => {
      if (!activeTeamId) return;
      void controller.refresh();
    }, [activeTeamId, controller]),
  );

  const [pinnedSessionIds, setPinnedSessionIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [hasAgents, setHasAgents] = useState(true);
  const [actorGlyphById, setActorGlyphById] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [zeroAgentSheetOpen, setZeroAgentSheetOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const zeroAgentCheckedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeTeamId) return;
    let cancelled = false;
    void createActorsApi({ getAccessToken: supabaseAccessToken(supabase) })
      .listActors(activeTeamId)
      .then((rows) => {
        if (cancelled) return;
        setHasAgents(rows.some((row) => row.actorType === "agent"));
        const glyphs = new Map<string, string>();
        for (const row of rows) {
          if (row.actorType === "agent") {
            switch (row.agentKind) {
              case "claude":
                glyphs.set(row.actorId, "CC");
                break;
              case "opencode":
                glyphs.set(row.actorId, "OC");
                break;
              case "codex":
                glyphs.set(row.actorId, "CX");
                break;
              default:
                if (row.displayName.length > 0) {
                  glyphs.set(
                    row.actorId,
                    row.displayName.charAt(0).toUpperCase() || "·",
                  );
                }
                break;
            }
          } else if (row.displayName.length > 0) {
            glyphs.set(row.actorId, row.displayName.charAt(0).toUpperCase());
          }
        }
        setActorGlyphById(glyphs);
      })
      .catch(() => {
        // Keep optimistic-true so we don't flash the empty-agents banner on transient errors.
      });
    return () => {
      cancelled = true;
    };
  }, [activeTeamId]);
  useEffect(() => {
    let cancelled = false;
    void loadPinnedSessions().then((set) => {
      if (!cancelled) setPinnedSessionIds(set);
    });
    const unsubscribe = subscribePinnedSessions((next) => {
      if (!cancelled) setPinnedSessionIds(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Show the zero-agent reminder sheet at most once per team. iOS uses
  // SwiftData for "have I shown this?"; here it lives in AsyncStorage.
  useEffect(() => {
    if (!activeTeamId || hasAgents) return;
    if (zeroAgentCheckedRef.current === activeTeamId) return;
    zeroAgentCheckedRef.current = activeTeamId;
    let cancelled = false;
    void hasShownZeroAgentReminder(activeTeamId).then((shown) => {
      if (cancelled || shown) return;
      setZeroAgentSheetOpen(true);
    });
    return () => {
      cancelled = true;
    };
  }, [activeTeamId, hasAgents]);

  const dismissZeroAgentSheet = useCallback(() => {
    setZeroAgentSheetOpen(false);
    if (activeTeamId) {
      void markZeroAgentReminderShown(activeTeamId);
    }
  }, [activeTeamId]);

  if (state.route !== "ready") {
    return <Redirect href={href ?? "/"} />;
  }

  if (state.currentTeam === null) {
    return <Redirect href="/" />;
  }

  return (
    <>
    <SessionsListScreen
      actorGlyphById={actorGlyphById}
      hasAgents={hasAgents}
      onInviteAgent={() => router.push("/(app)/invite")}
      onArchiveBatch={async (sessionIds) => {
        const now = new Date().toISOString();
        const api = createConfiguredSessionsApi(supabase);
        for (const id of sessionIds) {
          try {
            await api.setSessionArchived(id, now);
          } catch {
            // continue
          }
        }
        successTone();
        await controller.refresh();
      }}
      onLoad={() => {
        void controller.load();
      }}
      onMarkBatchRead={async (sessionIds) => {
        const actorId = state.currentMemberActorId;
        if (!actorId) return;
        const api = createConfiguredSessionsApi(supabase);
        for (const id of sessionIds) {
          try {
            await api.markSessionRead(id, actorId, null);
          } catch {
            // continue
          }
        }
        await controller.refresh();
      }}
      onMarkBatchUnread={async (sessionIds) => {
        const actorId = state.currentMemberActorId;
        if (!actorId) return;
        const api = createConfiguredSessionsApi(supabase);
        for (const id of sessionIds) {
          try {
            await api.markSessionUnread(id, actorId);
          } catch {
            // continue
          }
        }
        await controller.refresh();
      }}
      onNewSession={() => {
        router.push("/(app)/new-session");
      }}
      onTogglePin={async (sessionId) => {
        selectionTick();
        await togglePinnedSession(sessionId);
      }}
      pinnedSessionIds={pinnedSessionIds}
      onRefresh={() => {
        void controller.refresh();
      }}
      onSelectSession={(sessionId) => {
        router.push(`/(app)/sessions/${sessionId}`);
      }}
      onShortcuts={() => {
        setShortcutsOpen(true);
      }}
      state={listState}
    />
    <Modal
      animationType="slide"
      onRequestClose={dismissZeroAgentSheet}
      presentationStyle="pageSheet"
      visible={zeroAgentSheetOpen}
    >
      <ZeroAgentReminderSheet
        onAdd={() => {
          dismissZeroAgentSheet();
          router.push("/(app)/invite");
        }}
        onDismiss={dismissZeroAgentSheet}
      />
    </Modal>
    <ShortcutsDrawer
      isPresented={shortcutsOpen}
      onClose={() => setShortcutsOpen(false)}
      onOpenSettings={() => router.push("/(app)/settings")}
      onOpenShortcut={(shortcut) => {
        void openShortcutTarget(shortcut, { push: router.push });
      }}
      profileName={state.currentTeam?.name ?? "Signed out"}
      profileSubtitle={
        state.currentTeam ? `Team · ${state.currentTeam.name}` : null
      }
      teamId={activeTeamId}
    />
    </>
  );
}
