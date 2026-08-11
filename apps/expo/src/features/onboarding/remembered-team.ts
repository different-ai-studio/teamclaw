import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "teamclu.onboarding.rememberedTeamId";

/**
 * The team the user last chose, so the picker is a one-time question rather
 * than a toll on every launch. iOS keeps the same memory on its coordinator.
 *
 * Deliberately not in the SQLite cache: that is scoped per team, and this is
 * the value that decides which team's scope to open. It also has to survive a
 * cache clear — forgetting it would put a returning user back on the picker.
 *
 * Every method swallows its errors. A lost preference costs one extra tap; a
 * throw here would break launch.
 */
export type RememberedTeamStore = {
  load: () => Promise<string | null>;
  save: (teamId: string) => Promise<void>;
  clear: () => Promise<void>;
};

export function createRememberedTeamStore(
  storage: Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem"> = AsyncStorage,
): RememberedTeamStore {
  return {
    async load() {
      try {
        const value = await storage.getItem(STORAGE_KEY);
        return value?.trim() || null;
      } catch {
        return null;
      }
    },
    async save(teamId) {
      const trimmed = teamId.trim();
      if (!trimmed) return;
      try {
        await storage.setItem(STORAGE_KEY, trimmed);
      } catch {
        // best-effort
      }
    },
    async clear() {
      try {
        await storage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    },
  };
}
