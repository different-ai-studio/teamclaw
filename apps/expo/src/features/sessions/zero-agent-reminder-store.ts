import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_PREFIX = "teamclaw.zeroAgentReminder.v1.";

/**
 * Per-team "shown once" flag for the zero-agent onboarding reminder. iOS
 * tracks this in SwiftData; on Expo we persist per-team in AsyncStorage so
 * users who switch teams still get the prompt for the new team.
 *
 * Calling `mark` is idempotent — the second call is a no-op.
 */
export async function hasShownZeroAgentReminder(teamId: string): Promise<boolean> {
  if (!teamId) return true;
  try {
    const raw = await AsyncStorage.getItem(`${STORAGE_PREFIX}${teamId}`);
    return raw === "1";
  } catch {
    return true;
  }
}

export async function markZeroAgentReminderShown(teamId: string): Promise<void> {
  if (!teamId) return;
  try {
    await AsyncStorage.setItem(`${STORAGE_PREFIX}${teamId}`, "1");
  } catch {
    // best-effort
  }
}
