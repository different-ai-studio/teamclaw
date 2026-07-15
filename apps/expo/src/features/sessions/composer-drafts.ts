import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_PREFIX = "teamclaw.composerDraft.v1:";

function key(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

export async function loadComposerDraft(sessionId: string): Promise<string> {
  try {
    return (await AsyncStorage.getItem(key(sessionId))) ?? "";
  } catch {
    return "";
  }
}

export async function saveComposerDraft(
  sessionId: string,
  value: string,
): Promise<void> {
  try {
    if (!value || value.length === 0) {
      await AsyncStorage.removeItem(key(sessionId));
    } else {
      await AsyncStorage.setItem(key(sessionId), value);
    }
  } catch {
    // best-effort
  }
}
