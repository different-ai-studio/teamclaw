import * as React from "react";
import { collectAcpStreamingPermissions } from "@/lib/teamclaw/acp-permission-entries";
import { useSessionPermissionMode } from "@/lib/session-permission-mode";
import { useSessionStore } from "@/stores/session";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { collectVisiblePermissions } from "./permission-queue";

export function usePendingPermissionsQueue() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessionPermissionMode = useSessionPermissionMode(activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const pendingPermissions = useSessionStore((s) => s.pendingPermissions);
  const streamRevision = useV2StreamingStore((s) =>
    activeSessionId ? (s.revisionBySession[activeSessionId] ?? 0) : 0,
  );
  const [dismissedIds, setDismissedIds] = React.useState<string[]>([]);

  const acpStreamingPermissions = React.useMemo(() => {
    const streamByKey = useV2StreamingStore.getState().byKey;
    return collectAcpStreamingPermissions(activeSessionId, streamByKey);
  }, [activeSessionId, streamRevision]);

  const baseVisiblePermissions = React.useMemo(
    () =>
      collectVisiblePermissions(
        activeSessionId,
        sessions,
        pendingPermissions,
        acpStreamingPermissions,
      ),
    [activeSessionId, acpStreamingPermissions, pendingPermissions, sessions],
  );

  React.useEffect(() => {
    setDismissedIds((current) =>
      current.filter((id) =>
        baseVisiblePermissions.some((entry) => entry.permission.id === id),
      ),
    );
  }, [baseVisiblePermissions]);

  const visiblePermissions = React.useMemo(
    () =>
      baseVisiblePermissions.filter(
        (entry) => !dismissedIds.includes(entry.permission.id),
      ),
    [baseVisiblePermissions, dismissedIds],
  );

  const currentEntry = visiblePermissions[0] ?? null;
  const queuedCount = visiblePermissions.length;

  const onReplyStart = React.useCallback((permissionId: string) => {
    setDismissedIds((current) =>
      current.includes(permissionId) ? current : [...current, permissionId],
    );
  }, []);

  const onReplyRollback = React.useCallback((permissionId: string) => {
    setDismissedIds((current) => current.filter((id) => id !== permissionId));
  }, []);

  return {
    activeSessionId,
    sessionPermissionMode,
    visiblePermissions,
    currentEntry,
    queuedCount,
    onReplyStart,
    onReplyRollback,
  };
}
