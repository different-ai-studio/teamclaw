import * as React from "react";
import { useSessionStore } from "@/stores/session";
import { useStreamingStore } from "@/stores/streaming";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { buildSessionListActivityMap } from "@/lib/session-list-activity";
import type { PendingPermissionEntry } from "@/stores/session-types";
import {
  collectAcpStreamingPermissionsForList,
  selectStreamingPermissionSnapshot,
} from "@/lib/teamclaw/acp-permission-entries";

function mergePendingPermissionEntries(
  ...groups: PendingPermissionEntry[][]
): PendingPermissionEntry[] {
  const byId = new Map<string, PendingPermissionEntry>();
  for (const group of groups) {
    for (const entry of group) {
      const id = entry.permission?.id;
      if (id) byId.set(id, entry);
    }
  }
  return Array.from(byId.values());
}

export function useSessionListActivityMap(activeSessionId: string | null) {
  const allSessions = useSessionStore((s) => s.sessions);
  const sessionStatuses = useSessionStore((s) => s.sessionStatuses) || {};
  const pendingQuestionIdsBySession =
    useSessionStore((s) => s.pendingQuestionIdsBySession) || {};
  const pendingQuestions = useSessionStore((s) => s.pendingQuestions) || [];
  const legacyPendingPermissions =
    useSessionStore((s) => s.pendingPermissions) || [];
  const streamingMessageId = useStreamingStore((s) => s.streamingMessageId);
  const childSessionStreaming = useStreamingStore((s) => s.childSessionStreaming);
  const permissionSnapshot = useV2StreamingStore((s) =>
    selectStreamingPermissionSnapshot(s.byKey),
  );

  return React.useMemo(
    () =>
      buildSessionListActivityMap({
        sessions: allSessions,
        activeSessionId,
        sessionStatuses,
        pendingQuestionIdsBySession,
        pendingQuestions,
        pendingPermissions: mergePendingPermissionEntries(
          legacyPendingPermissions,
          collectAcpStreamingPermissionsForList(
            useV2StreamingStore.getState().byKey,
          ),
        ),
        streamingMessageId,
        streamingChildSessionIds: Object.values(childSessionStreaming)
          .filter((state) => state?.isStreaming)
          .map((state) => state.sessionId),
      }),
    [
      activeSessionId,
      allSessions,
      childSessionStreaming,
      legacyPendingPermissions,
      pendingQuestionIdsBySession,
      pendingQuestions,
      permissionSnapshot,
      sessionStatuses,
      streamingMessageId,
    ],
  );
}
