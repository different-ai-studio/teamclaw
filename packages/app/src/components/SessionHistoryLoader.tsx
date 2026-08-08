/**
 * Loads message history for whichever session is active.
 *
 * Local-first: Tauri hydrates from the libsql cache first and delta-syncs in
 * the background; the extension reads its chrome.storage cache; everything
 * else pulls straight from the backend.
 *
 * Split out of `AppContent` because it is self-contained wiring — it takes no
 * props, renders nothing, and writes only to the session-message store — and
 * because its subscriptions (active session, refresh trigger) have no business
 * re-rendering the app shell.
 */
import { useEffect, useRef } from "react";
import { isChromeExtension } from "@/lib/platform";
import { isTauri } from "@/lib/utils";
import { isV2E2EControlActive } from "@/lib/e2e/v2-control";
import { getBackend } from "@/lib/backend";
import { historyRowsToMessageRows } from "@/lib/message-history-map";
import { messageRowsToProto } from "@/lib/session-export/collect";
import { syncMessagesForSession } from "@/lib/sync/message-sync";
import { logExtMsgDiag, summarizeProtosForExtDiag } from "@/lib/extension-msg-diag";
import { create as createMessage } from "@bufbuild/protobuf";
import { MessageSchema, MessageKind } from "@/lib/proto/teamclaw_pb";
import { useSessionListStore } from "@/stores/session-list-store";
import { useSessionMessageStore } from "@/stores/session-message-store";
import { useSessionSelectionStore } from "@/stores/session-selection-store";
import { useWorkspaceStore } from "@/stores/workspace";

export function SessionHistoryLoader() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  // v2 Phase 1 → local-first: load message history whenever the active
  // session changes.
  //   1. Tauri: hydrate immediately from local libsql cache (no Supabase wait).
  //   2. Background: delta-sync from Supabase (watermark-based), upsert local,
  //      re-render if anything new arrived.
  //   3. Extension: chrome.storage.local cache (same MessageRow shape) + full
  //      cloud pull; COALESCE preserves local parts_json.
  //   4. Other Non-Tauri: full backend pull.
  // agent_runtime_event table is no longer read here — those rows were written
  // with origin="mqtt-live" into the message table by new envelope handler code.
  // TODO(cleanup): remove agent_runtime_event table once all clients have
  // upgraded past this version.
  const currentSessionId = useSessionSelectionStore((s) => s.currentSessionId);
  const messageRefreshTrigger = useSessionMessageStore((s) => s.messageRefreshTrigger);
  const messageRefreshForceFull = useSessionMessageStore((s) => s.messageRefreshForceFull);
  const prevRefreshTriggerRef = useRef(0);

  // Extension: prune message cache on sidepanel open (in addition to write/load).
  useEffect(() => {
    if (!isChromeExtension()) return;
    void import("@/lib/extension-message-cache").then(({ pruneExtensionMessageCache }) =>
      pruneExtensionMessageCache(),
    );
  }, []);

  useEffect(() => {
    if (!currentSessionId) return;
    if (isV2E2EControlActive()) return;
    // A refresh-trigger bump on the SAME session = user pressed ↻, or an
    // explicit full reload (e.g. opening a cron session from run history).
    const triggerBumped =
      messageRefreshTrigger !== prevRefreshTriggerRef.current;
    const forceFull =
      messageRefreshForceFull ||
      (triggerBumped && prevRefreshTriggerRef.current !== 0);
    prevRefreshTriggerRef.current = messageRefreshTrigger;
    if (messageRefreshForceFull) {
      useSessionMessageStore.setState({ messageRefreshForceFull: false });
    }
    let cancelled = false;
    const kindMap: Record<string, MessageKind> = {
      text: MessageKind.TEXT,
      system: MessageKind.SYSTEM,
      agent_thinking: MessageKind.AGENT_THINKING,
      agent_tool_call: MessageKind.AGENT_TOOL_CALL,
      agent_tool_result: MessageKind.AGENT_TOOL_RESULT,
      agent_reply: MessageKind.AGENT_REPLY,
    };

    void (async () => {
      if (isTauri()) {
        // ── Phase 1: instant render from local cache ──────────────────
        const { loadMessagesForSession } = await import("@/lib/local-cache");
        const localMsgs = await loadMessagesForSession(
          currentSessionId,
          false,
          workspacePath,
        );
        if (cancelled) return;
        if (localMsgs.length > 0) {
          useSessionMessageStore.getState().setMessages(
            currentSessionId,
            messageRowsToProto(localMsgs),
          );
        }

        // ── Phase 2: background delta sync from Supabase ─────────────
        const teamId =
          useSessionListStore.getState().rows.find(
            (r) => r.id === currentSessionId,
          )?.team_id ?? "";
        const synced = await syncMessagesForSession(
          currentSessionId,
          teamId,
          { full: forceFull },
        );
        if (forceFull && teamId) {
          // Also force-refresh participants on user-driven refresh.
          const { syncParticipantsForSession } = await import(
            "@/lib/sync/session-participant-sync"
          );
          await syncParticipantsForSession(currentSessionId, teamId, {
            full: true,
          });
        }
        if (cancelled) return;
        if (synced > 0) {
          // Re-read from local cache to surface the newly-synced rows
          const fresh = await loadMessagesForSession(
            currentSessionId,
            false,
            workspacePath,
          );
          if (!cancelled) {
            useSessionMessageStore.getState().setMessages(
              currentSessionId,
              messageRowsToProto(fresh),
            );
          }
        }
        return;
      }

      // ── Extension: local-first (chrome.storage) + full cloud pull ─
      // Same shape as desktop: hydrate cache → upsert cloud rows (COALESCE
      // parts_json) → re-read. Eviction runs inside the cache writes / load.
      if (isChromeExtension()) {
        const { loadMessagesForSession, upsertMessagesBatch } = await import(
          "@/lib/local-cache"
        );
        const localMsgs = await loadMessagesForSession(currentSessionId, false);
        if (cancelled) return;
        if (localMsgs.length > 0) {
          const localProtos = messageRowsToProto(localMsgs);
          useSessionMessageStore
            .getState()
            .setMessages(currentSessionId, localProtos);
          logExtMsgDiag("history.ext.hydrateLocal", {
            sessionId: currentSessionId,
            ...summarizeProtosForExtDiag(localProtos),
          });
        }

        let historyRows;
        try {
          historyRows = await getBackend().messages.listMessages(currentSessionId);
        } catch (error) {
          console.warn(
            "[history] load failed:",
            error instanceof Error ? error.message : error,
          );
          if (!cancelled && localMsgs.length === 0) {
            useSessionMessageStore.getState().setMessages(currentSessionId, []);
          }
          return;
        }
        if (cancelled) return;

        const teamId =
          useSessionListStore.getState().rows.find((r) => r.id === currentSessionId)
            ?.team_id ?? "";
        const memoryBeforeCloud = useSessionMessageStore.getState().messages[
          currentSessionId
        ] ?? [];
        logExtMsgDiag("history.ext.beforeCloudUpsert", {
          sessionId: currentSessionId,
          cloudCount: historyRows.length,
          memory: summarizeProtosForExtDiag(memoryBeforeCloud),
        });
        await upsertMessagesBatch(
          historyRowsToMessageRows(historyRows, {
            teamId,
            origin: getBackend().kind,
          }),
        );
        if (cancelled) return;

        const fresh = await loadMessagesForSession(currentSessionId, false);
        if (!cancelled) {
          const freshProtos = messageRowsToProto(fresh);
          useSessionMessageStore
            .getState()
            .setMessages(currentSessionId, freshProtos);
          logExtMsgDiag("history.ext.afterSetMessages", {
            sessionId: currentSessionId,
            note: "whole-replace from cache after cloud upsert — check partsLen / interruptCount",
            ...summarizeProtosForExtDiag(freshProtos),
          });
        }
        return;
      }

      // ── Non-Tauri web: full backend pull ──────────────────────────
      let historyRows;
      try {
        historyRows = await getBackend().messages.listMessages(currentSessionId);
      } catch (error) {
        console.warn("[history] load failed:", error instanceof Error ? error.message : error);
        if (!cancelled) {
          useSessionMessageStore.getState().setMessages(currentSessionId, []);
        }
        return;
      }
      if (cancelled) return;
      const backendMsgs = historyRows.map((r) => {
        const metadataJson =
          r.metadata == null
            ? ""
            : typeof r.metadata === "string"
              ? r.metadata
              : JSON.stringify(r.metadata);
        return createMessage(MessageSchema, {
          messageId: r.id,
          sessionId: r.session_id,
          senderActorId: r.sender_actor_id ?? "",
          kind: kindMap[r.kind] ?? MessageKind.TEXT,
          content: r.content ?? "",
          model: r.model ?? "",
          turnId: r.turn_id ?? "",
          replyToMessageId: r.reply_to_message_id ?? "",
          metadataJson,
          createdAt: BigInt(Math.floor(new Date(r.created_at).getTime() / 1000)),
        });
      });
      useSessionMessageStore.getState().setMessages(currentSessionId, backendMsgs);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId, messageRefreshTrigger, messageRefreshForceFull, workspacePath]);

  return null;
}
