import { appShortName } from "@/lib/build-config";

const STORAGE_KEY = `${appShortName}-pinned-sessions`;

type PinnedSessionStorage = Record<string, string[]>;

function parsePinnedSessionStorage(raw: string | null): PinnedSessionStorage | null {
  try {
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Backward compatibility with the legacy flat-array format.
      return { __legacy__: parsed.filter((item): item is string => typeof item === "string") };
    }
    if (!parsed || typeof parsed !== "object") return {};

    const entries = Object.entries(parsed as Record<string, unknown>);
    return Object.fromEntries(
      entries.map(([workspaceKey, ids]) => [
        workspaceKey,
        Array.isArray(ids) ? ids.filter((item): item is string => typeof item === "string") : [],
      ]),
    );
  } catch {
    return {};
  }
}

function normalizeWorkspaceKey(workspacePath: string | null | undefined): string | null {
  const trimmed = workspacePath?.trim();
  return trimmed ? trimmed : null;
}

export function loadPinnedSessionIds(workspacePath?: string | null): string[] {
  const storage = parsePinnedSessionStorage(localStorage.getItem(STORAGE_KEY));
  const workspaceKey = normalizeWorkspaceKey(workspacePath);

  if (!storage) return [];
  if (workspaceKey) {
    return storage[workspaceKey] ?? storage.__legacy__ ?? [];
  }
  return storage.__legacy__ ?? [];
}

export function savePinnedSessionIds(
  workspacePath: string | null | undefined,
  ids: string[],
): void {
  try {
    const workspaceKey = normalizeWorkspaceKey(workspacePath);
    const storage = parsePinnedSessionStorage(localStorage.getItem(STORAGE_KEY)) ?? {};

    if (!workspaceKey) {
      storage.__legacy__ = ids;
    } else if (ids.length > 0) {
      storage[workspaceKey] = ids;
      delete storage.__legacy__;
    } else {
      delete storage[workspaceKey];
      delete storage.__legacy__;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
  } catch {
    // Ignore storage failures so session list still works in constrained envs.
  }
}

export function sanitizePinnedSessionIds(
  pinnedIds: string[],
  validSessionIds: Iterable<string>,
): string[] {
  const validSet = new Set(validSessionIds);
  const uniquePinned: string[] = [];

  for (const id of pinnedIds) {
    if (validSet.has(id) && !uniquePinned.includes(id)) {
      uniquePinned.push(id);
    }
  }

  return uniquePinned;
}
