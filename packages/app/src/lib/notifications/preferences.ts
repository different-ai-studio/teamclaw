import { getBackend } from '@/lib/backend';

export interface NotificationPrefs {
  enabled: boolean;
  dnd_start_min: number | null;
  dnd_end_min: number | null;
  dnd_tz: string;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  dnd_start_min: null,
  dnd_end_min: null,
  dnd_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
};

export async function loadPrefs(userId: string): Promise<NotificationPrefs> {
  try {
    const data = await getBackend().notifications.loadPreferences(userId);
    if (!data) return DEFAULT_PREFS;
    return {
      enabled: data.enabled ?? DEFAULT_PREFS.enabled,
      dnd_start_min: data.dnd_start_min ?? null,
      dnd_end_min: data.dnd_end_min ?? null,
      dnd_tz: data.dnd_tz ?? DEFAULT_PREFS.dnd_tz,
    };
  } catch (error) {
    console.warn('[notifications] loadPrefs failed, using defaults', error);
    return DEFAULT_PREFS;
  }
}

export async function savePrefs(userId: string, p: NotificationPrefs): Promise<void> {
  await getBackend().notifications.savePreferences({ user_id: userId, ...p, updated_at: new Date().toISOString() });
}

export async function setSessionMuted(
  userId: string, sessionId: string, muted: boolean
): Promise<void> {
  await getBackend().notifications.setSessionMuted({ userId, sessionId, muted });
}

export async function isSessionMuted(userId: string, sessionId: string): Promise<boolean> {
  try {
    const mutedSessionIds = await getBackend().notifications.listMutedSessionIds(userId);
    return mutedSessionIds.includes(sessionId);
  } catch (error) {
    console.warn('[notifications] isSessionMuted failed, treating as unmuted', error);
    return false;
  }
}

export function isInDndWindow(prefs: { dnd_start_min: number | null;
                                       dnd_end_min: number | null;
                                       dnd_tz: string },
                              now: Date): boolean {
  if (prefs.dnd_start_min == null || prefs.dnd_end_min == null) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: prefs.dnd_tz, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
  const localMin = h * 60 + m;
  const a = prefs.dnd_start_min, b = prefs.dnd_end_min;
  if (a === b) return false;
  return a < b ? (localMin >= a && localMin < b)
               : (localMin >= a || localMin < b);
}
