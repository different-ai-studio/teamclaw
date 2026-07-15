import { createCloudApiClient } from "../../lib/cloud-api/client";
import type { Shortcut, ShortcutNodeType, ShortcutScope } from "./shortcut-types";

export type ShortcutsApi = {
  listShortcuts: (teamId: string) => Promise<Shortcut[]>;
  renameShortcut: (id: string, label: string) => Promise<void>;
  deleteShortcut: (id: string) => Promise<void>;
};

// FC returns the raw snake_case shortcut row shape (see services/fc supabase-repo
// mapShortcutRow): { id, scope, label, owner_member_id, team_id, parent_id, icon,
// order, node_type, target, created_at, updated_at }.
type CloudShortcut = {
  id: string;
  label: string | null;
  icon: string | null;
  node_type: string | null;
  target: string | null;
  order: number | null;
  parent_id: string | null;
  scope: string | null;
};

function toNodeType(value: string | null): ShortcutNodeType {
  switch (value) {
    case "folder":
    case "team":
    case "session":
    case "external":
      return value;
    case "url":
    default:
      return "url";
  }
}

function toScope(value: string | null): ShortcutScope {
  return value === "team" ? "team" : "personal";
}

function toShortcut(row: CloudShortcut): Shortcut {
  return {
    id: row.id,
    label: row.label?.trim() || "Shortcut",
    icon: row.icon ?? null,
    nodeType: toNodeType(row.node_type),
    target: row.target ?? null,
    order: row.order ?? 0,
    parentId: row.parent_id ?? null,
    scope: toScope(row.scope),
  };
}

export function createCloudShortcutsApi(args: {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): ShortcutsApi {
  const client = createCloudApiClient(args);

  return {
    async listShortcuts(teamId: string): Promise<Shortcut[]> {
      const result = await client.get<{ items: CloudShortcut[] }>(
        `/v1/teams/${encodeURIComponent(teamId)}/shortcuts`,
      );
      return (result.items ?? []).map(toShortcut);
    },
    async renameShortcut(id: string, label: string): Promise<void> {
      await client.patch(`/v1/shortcuts/${encodeURIComponent(id)}`, { label });
    },
    async deleteShortcut(id: string): Promise<void> {
      await client.del(`/v1/shortcuts/${encodeURIComponent(id)}`);
    },
  };
}
