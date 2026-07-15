import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "teamclaw.pinnedSessions.v1";

type Listener = (pinned: ReadonlySet<string>) => void;

let cache: Set<string> | null = null;
const listeners = new Set<Listener>();

async function load(): Promise<Set<string>> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        cache = new Set(parsed.filter((v): v is string => typeof v === "string"));
        return cache;
      }
    }
  } catch {
    // ignore — fall through to empty
  }
  cache = new Set();
  return cache;
}

async function persist(next: Set<string>) {
  cache = next;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // best-effort
  }
  for (const listener of listeners) listener(new Set(next));
}

/**
 * Per-device sticky-pinned session ids. Lives in AsyncStorage so the
 * preference survives app launches without needing a Postgres column.
 * iOS keeps the same data inside `NSUbiquitousKeyValueStore`, scoped
 * to the device — same boundary.
 */
export async function loadPinnedSessions(): Promise<ReadonlySet<string>> {
  return new Set(await load());
}

export async function togglePinnedSession(sessionId: string): Promise<ReadonlySet<string>> {
  const current = await load();
  const next = new Set(current);
  if (next.has(sessionId)) next.delete(sessionId);
  else next.add(sessionId);
  await persist(next);
  return next;
}

export function subscribePinnedSessions(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
