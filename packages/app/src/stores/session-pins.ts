import { appShortName } from "@/lib/build-config";

const STORAGE_KEY = `${appShortName}-pinned-sessions`;

export function loadPinnedSessionIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function savePinnedSessionIds(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
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

