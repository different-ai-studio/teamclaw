import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Persisted Cloud API session + token lifecycle. Replaces the Supabase SDK's
 * session management: stores the GoTrue tokens in AsyncStorage, refreshes the
 * access token proactively via `POST /v1/auth/refresh`, and notifies listeners
 * (the `onAuthStateChange` surface the app's MQTT reconnect + re-bootstrap
 * depend on). Mirrors the iOS `SessionStore`.
 */
export type StoredSession = {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
  isAnonymous: boolean;
  email: string | null;
  userId: string | null;
};

const STORAGE_KEY = "teamclu.cloud-session";
// Refresh when the access token is within this many seconds of expiry.
const REFRESH_SKEW_SECONDS = 60;

type RefreshResponse = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

type SessionStoreOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  storage?: Pick<typeof AsyncStorage, "getItem" | "setItem" | "removeItem">;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function createSessionStore(options: SessionStoreOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const storage = options.storage ?? AsyncStorage;

  let session: StoredSession | null = null;
  let started = false;
  let inFlightRefresh: Promise<StoredSession | null> | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  async function persist(): Promise<void> {
    if (session) {
      await storage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      await storage.removeItem(STORAGE_KEY);
    }
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    try {
      const raw = await storage.getItem(STORAGE_KEY);
      if (raw) session = JSON.parse(raw) as StoredSession;
    } catch {
      session = null;
    }
  }

  async function clearSession(): Promise<void> {
    const had = session !== null;
    session = null;
    await persist();
    if (had) notify();
  }

  async function refresh(): Promise<StoredSession | null> {
    if (!session?.refreshToken) return null;
    const refreshToken = session.refreshToken;
    const response = await fetchImpl(`${baseUrl}/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const text = await response.text();
    const payload = (text ? JSON.parse(text) : null) as RefreshResponse | null;
    if (!response.ok || !payload?.accessToken || !payload?.refreshToken) {
      // Refresh failed — the session is no longer valid. Clear it so the app
      // routes back to auth rather than wedging on a dead token.
      await clearSession();
      return null;
    }
    session = {
      ...(session as StoredSession),
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresAt: payload.expiresAt ?? nowSeconds() + 3600,
    };
    await persist();
    notify();
    return session;
  }

  return {
    start,

    current(): StoredSession | null {
      return session;
    },

    /**
     * `silent` stores the session without waking subscribers.
     *
     * Subscribers exist to react to *who is signed in* changing — the app's
     * listener re-runs `bootstrap()`. A token swap for the same user is not
     * that, and announcing it is actively harmful when the swap happens
     * *inside* bootstrap: team activation calls `setRefreshSession`, so the
     * notify re-entered `bootstrap`, whose `beginOperation()` invalidated the
     * in-flight run's token and made its `bootstrapResolved` a no-op. That
     * loops forever, leaving the app on "Opening TeamClu" and hammering
     * `/v1/teams` + activate + refresh on every pass.
     */
    async setSession(next: StoredSession, options?: { silent?: boolean }): Promise<void> {
      session = next;
      await persist();
      if (!options?.silent) notify();
    },

    clear: clearSession,

    /** Returns a valid access token, refreshing proactively when near expiry. */
    async accessToken(): Promise<string | null> {
      await start();
      if (!session) return null;
      if (session.expiresAt - REFRESH_SKEW_SECONDS > nowSeconds()) {
        return session.accessToken;
      }
      // Coalesce concurrent refreshes.
      if (!inFlightRefresh) {
        inFlightRefresh = refresh().finally(() => {
          inFlightRefresh = null;
        });
      }
      const refreshed = await inFlightRefresh;
      return refreshed?.accessToken ?? null;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
