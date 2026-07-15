import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "teamclaw.pendingInviteToken.v1";

/**
 * Single-slot persistence for an invite token that arrived before the user
 * was authenticated. Mirrors iOS `AppOnboardingCoordinator.pendingInviteToken`
 * but lives in AsyncStorage so it survives a relaunch — RN doesn't keep the
 * coordinator in memory across cold starts the way SwiftUI's State does.
 *
 * The replay site (in the onboarding root layout) is expected to:
 *   1. Read `loadPendingInviteToken()` after sign-in completes
 *   2. Call the invite-api `claim()` if the token is present
 *   3. Call `clearPendingInviteToken()` regardless of the outcome
 */
export async function savePendingInviteToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) return;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, trimmed);
  } catch {
    // best-effort
  }
}

export async function loadPendingInviteToken(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export async function clearPendingInviteToken(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}
