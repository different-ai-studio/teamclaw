import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getOpenCodeClient } from "@/lib/opencode/client";
import { isTauri } from "@/lib/utils";
import { notificationService } from "@/lib/notification-service";
import { shouldAutoAuthorize } from "@/lib/permission-policy";
import type { PermissionAskedEvent } from "@/lib/opencode/types";
import { useWorkspaceStore } from "@/stores/workspace";
import type {
  ToolCallPermission,
  SessionState,
} from "./session-types";
import {
  sessionLookupCache,
  getSessionById,
} from "./session-cache";
import {
  pendingPermissionBuffer,
  attachPermissionToToolCall,
} from "./session-internals";

/**
 * Cache of permission config from opencode.json.
 * Maps permission name (e.g. "bash", "write") to its action ("allow" | "ask" | "deny").
 */
let _permConfigCache: Record<string, string> | null = null;
let _permConfigLoading = false;

async function loadPermissionConfig(): Promise<Record<string, string>> {
  if (_permConfigCache) return _permConfigCache;
  if (!isTauri()) return {};

  const workspacePath = useWorkspaceStore.getState().workspacePath;
  if (!workspacePath) return {};

  if (_permConfigLoading) return {};
  _permConfigLoading = true;

  try {
    const { readTextFile, exists } = await import("@tauri-apps/plugin-fs");
    const configPath = `${workspacePath}/opencode.json`;
    if (!(await exists(configPath))) return {};

    const content = await readTextFile(configPath);
    const config = JSON.parse(content);
    if (config.permission && typeof config.permission === "object") {
      _permConfigCache = config.permission;
      return _permConfigCache!;
    }
  } catch {
    // ignore read errors
  } finally {
    _permConfigLoading = false;
  }
  return {};
}

/**
 * In-memory set of permission types the user has clicked "Always Allow" for
 * during this app session. Prevents repeated dialogs for the same permission type.
 */
const _alwaysAllowedPermissions = new Set<string>();

/** Pre-load the permission config cache. Call early so it's available synchronously later. */
export function loadPermissionConfigCache(): void {
  loadPermissionConfig().catch(() => { /* ignore */ });
}

/** Invalidate the permission config cache (call when config is saved). */
export function invalidatePermissionConfigCache(): void {
  _permConfigCache = null;
}

type SessionSet = (fn: ((state: SessionState) => Partial<SessionState>) | Partial<SessionState>) => void;
type SessionGet = () => SessionState;

/**
 * Persist an "always allow" rule to opencode.db so it survives server restarts.
 */
async function persistAllowlistRule(perm: PermissionAskedEvent): Promise<void> {
  if (!isTauri()) return;

  const workspacePath = useWorkspaceStore.getState().workspacePath;
  let projectId: string;
  try {
    projectId = await invoke<string>("get_opencode_project_id", {
      workspacePath: workspacePath || "/",
    });
  } catch {
    projectId = "global";
  }

  const patterns: string[] = [];
  if (perm.always && perm.always.length > 0) {
    patterns.push(...perm.always);
  } else if (perm.patterns && perm.patterns.length > 0) {
    const firstToken = perm.patterns[0]?.split(" ")[0];
    if (firstToken) patterns.push(`${firstToken} *`);
  }

  if (patterns.length === 0) return;

  type Rule = { permission: string; pattern: string; action: string };
  type Row = { project_id: string; rules: Rule[] };
  let existingRows: Row[] = [];
  try {
    existingRows = await invoke<Row[]>("read_opencode_allowlist");
  } catch {
    // DB may not exist yet
  }

  const row = existingRows.find((r) => r.project_id === projectId);
  const currentRules: Rule[] = row?.rules ?? [];

  for (const pat of patterns) {
    const alreadyExists = currentRules.some(
      (r) => r.permission === perm.permission && r.pattern === pat
    );
    if (!alreadyExists) {
      currentRules.push({ permission: perm.permission, pattern: pat, action: "allow" });
    }
  }

  await invoke("write_opencode_allowlist", {
    projectId,
    rules: currentRules,
  });

  console.log(
    "[Session] Persisted allowlist rules to DB for project '%s': %s %s",
    projectId,
    perm.permission,
    patterns.join(", ")
  );
}

export function createPermissionActions(set: SessionSet, get: SessionGet) {
  return {
    handlePermissionAsked: (event: PermissionAskedEvent) => {
      // Check permission policy -- auto-authorize if bypass or batch-done
      if (shouldAutoAuthorize()) {
        const client = getOpenCodeClient();
        client.replyPermission(event.id, { reply: "always" }).catch((err) => {
          console.error("[Session] Failed to auto-reply permission:", err);
        });
        return;
      }

      // Check opencode.json permission config -- auto-authorize if set to "allow"
      if (event.permission && _permConfigCache?.[event.permission] === "allow") {
        const client = getOpenCodeClient();
        client.replyPermission(event.id, { reply: "once" }).catch((err) => {
          console.error("[Session] Failed to auto-reply permission from config:", err);
        });
        return;
      }

      // Check if this permission type was already "Always Allowed" during this session
      if (event.permission && _alwaysAllowedPermissions.has(event.permission)) {
        const client = getOpenCodeClient();
        client.replyPermission(event.id, { reply: "always" }).catch((err) => {
          console.error("[Session] Failed to auto-reply always-allowed permission:", err);
        });
        return;
      }

      const {
        activeSessionId,
        sessions: currentSessions,
        setActiveSession: navigateToSession,
      } = get();

      const isChild = !getSessionById(event.sessionID) && event.sessionID !== activeSessionId;

      if (event.tool?.callID && !isChild) {
        const attached = attachPermissionToToolCall(event);
        if (!attached) {
          pendingPermissionBuffer.set(event.tool.callID, event);
        }
      } else {
        set({
          pendingPermission: event,
          pendingPermissionChildSessionId: isChild ? event.sessionID : null
        });
      }

      // Send notification for permission requests
      {
        const session = currentSessions.find((s) => s.id === event.sessionID);
        const sessionTitle = session?.title || "Session";
        const permissionType = event.permission || "unknown";

        notificationService.send(
          "action_required",
          "TeamClaw - Authorization required",
          `${sessionTitle} \u2014 requesting ${permissionType} permission`,
          event.sessionID,
          async () => {
            try {
              await navigateToSession(event.sessionID);
              const appWindow = getCurrentWindow();
              await appWindow.setFocus();
              await appWindow.unminimize();
            } catch {
              // Ignore focus errors
            }
          },
        );
      }
    },

    replyPermission: async (
      permissionId: string,
      decision: "allow" | "deny" | "always",
    ) => {
      const replyMap: Record<string, "once" | "always" | "reject"> = {
        allow: "once",
        deny: "reject",
        always: "always",
      };

      const decisionState: ToolCallPermission["decision"] =
        decision === "deny" ? "denied" : decision === "always" ? "allowlisted" : "approved";

      try {
        const client = getOpenCodeClient();
        await client.replyPermission(permissionId, {
          reply: replyMap[decision],
        });

        // Persist "always" decisions to opencode.db and cache in memory
        if (decision === "always") {
          const { activeSessionId, pendingPermission } = get();
          const session = activeSessionId ? getSessionById(activeSessionId) : null;
          let permEvent: PermissionAskedEvent | null = null;

          if (session) {
            for (const m of session.messages) {
              const tc = m.toolCalls?.find((t) => t.permission?.id === permissionId);
              if (tc?.permission) {
                permEvent = {
                  id: tc.permission.id,
                  sessionID: activeSessionId!,
                  permission: tc.permission.permission,
                  patterns: tc.permission.patterns,
                  always: tc.permission.always,
                  metadata: tc.permission.metadata,
                };
                break;
              }
            }
          }
          if (!permEvent && pendingPermission?.id === permissionId) {
            permEvent = pendingPermission;
          }
          if (permEvent) {
            // Cache in memory so subsequent requests for same permission type are auto-approved
            if (permEvent.permission) {
              _alwaysAllowedPermissions.add(permEvent.permission);
            }
            persistAllowlistRule(permEvent).catch((err) => {
              console.error("[Session] Failed to persist allowlist rule to DB:", err);
            });
          }
        }

        // Update the tool call's permission.decision in place
        const { activeSessionId } = get();
        if (activeSessionId) {
          set((state) => {
            const session = getSessionById(activeSessionId);
            if (!session) return {};
            let found = false;
            const newMessages = session.messages.map((m) => {
              const tcIdx = m.toolCalls?.findIndex((tc) => tc.permission?.id === permissionId);
              if (tcIdx === undefined || tcIdx === -1) return m;
              found = true;
              const newToolCalls = [...(m.toolCalls || [])];
              newToolCalls[tcIdx] = {
                ...newToolCalls[tcIdx],
                permission: { ...newToolCalls[tcIdx].permission!, decision: decisionState },
              };
              return { ...m, toolCalls: newToolCalls };
            });
            if (!found) {
              if (state.pendingPermission?.id === permissionId) {
                return { pendingPermission: null, pendingPermissionChildSessionId: null };
              }
              return {};
            }
            const newSession = { ...session, messages: newMessages };
            sessionLookupCache.set(activeSessionId, newSession);
            return {
              sessions: state.sessions.map((s) =>
                s.id === activeSessionId ? newSession : s,
              ),
            };
          });
        }

        // Also clear floating pendingPermission if it matches
        const { pendingPermission: floating } = get();
        if (floating?.id === permissionId) {
          set({ pendingPermission: null, pendingPermissionChildSessionId: null });
        }
      } catch (error) {
        console.error("[Session] Failed to reply permission:", error);
        set({
          error:
            error instanceof Error
              ? error.message
              : "Failed to reply to permission",
        });
      }
    },

    pollPermissions: async () => {
      const { activeSessionId } = get();
      if (!activeSessionId) return;

      try {
        const client = getOpenCodeClient();
        const permissions = await client.listPermissions();
        if (!permissions || permissions.length === 0) return;

        if (shouldAutoAuthorize()) {
          console.log("[Session] Auto-authorizing polled permissions (policy: bypass/batch-done)");
          for (const perm of permissions) {
            client.replyPermission(perm.id, { reply: "always" }).catch((err) => {
              console.error("[Session] Failed to auto-reply polled permission:", err);
            });
          }
          return;
        }

        // Auto-authorize permissions that are set to "allow" in opencode.json or already "Always Allowed"
        {
          const remaining = permissions.filter((perm) => {
            if (perm.permission && _permConfigCache?.[perm.permission] === "allow") {
              client.replyPermission(perm.id, { reply: "once" }).catch((err) => {
                console.error("[Session] Failed to auto-reply polled permission from config:", err);
              });
              return false;
            }
            if (perm.permission && _alwaysAllowedPermissions.has(perm.permission)) {
              client.replyPermission(perm.id, { reply: "always" }).catch((err) => {
                console.error("[Session] Failed to auto-reply polled always-allowed permission:", err);
              });
              return false;
            }
            return true;
          });
          if (remaining.length === 0) return;
        }

        const match = permissions.find((p) => p.sessionID === activeSessionId) || permissions[0];

        if (match.tool?.callID) {
          const session = getSessionById(activeSessionId);
          const alreadyAttached = session?.messages.some((m) =>
            m.toolCalls?.some((tc) => tc.permission?.id === match.id),
          );
          if (!alreadyAttached) {
            const attached = attachPermissionToToolCall(match);
            if (!attached) {
              pendingPermissionBuffer.set(match.tool.callID, match);
            }
          }
        } else {
          const { pendingPermission } = get();
          if (!pendingPermission) {
            set({ pendingPermission: match });
          }
        }
      } catch {
        // Silently ignore polling errors
      }
    },
  };
}
