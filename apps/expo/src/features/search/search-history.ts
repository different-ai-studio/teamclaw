import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "teamclaw.searchHistory.v1";
const MAX_ENTRIES = 8;

export async function loadSearchHistory(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

export async function recordSearchQuery(query: string): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return loadSearchHistory();
  const current = await loadSearchHistory();
  const filtered = current.filter((entry) => entry !== trimmed);
  const next = [trimmed, ...filtered].slice(0, MAX_ENTRIES);
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort
  }
  return next;
}

export async function clearSearchHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
