import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { getPermissionPolicy } from "@/lib/permission-policy";
import { isTauri } from "@/lib/utils";
import { appShortName } from "@/lib/build-config";

// --- Types ---

export type NotificationType = "action_required" | "task_completed" | "info";

export type NotificationLevel = "all" | "important" | "mute";

const NOTIFICATION_LEVEL_KEY = `${appShortName}-notification-level`;
const DEFAULT_LEVEL: NotificationLevel = "important";
const THROTTLE_WINDOW_MS = 5000; // 5 seconds dedup window for task_completed

// --- Level filtering ---

/** Which notification types are allowed at each level */
const LEVEL_ALLOWS: Record<NotificationLevel, Set<NotificationType>> = {
  all: new Set(["action_required", "task_completed", "info"]),
  important: new Set(["action_required", "task_completed"]),
  mute: new Set(),
};

// --- NotificationService ---

class NotificationService {
  /** Tracks last notification timestamp per session for dedup */
  private lastNotified = new Map<string, number>();
  /** Currently active (focused) session ID — set by session store */
  activeSessionId: string | null = null;
  /** Whether the main window is currently visible/focused */
  isWindowVisible = true;

  constructor() {
    // Track window visibility via document.visibilityState and Tauri focus events
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        this.isWindowVisible = document.visibilityState === "visible";
      });
    }
    // Also track via Tauri window focus/blur for more accurate state
    if (isTauri()) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        win.onFocusChanged(({ payload: focused }) => {
          this.isWindowVisible = focused;
        });
      }).catch(() => {
        // Tauri API not available
      });
    }
  }

  /** Read the user's notification level from localStorage */
  getLevel(): NotificationLevel {
    try {
      const stored = localStorage.getItem(NOTIFICATION_LEVEL_KEY);
      if (stored === "all" || stored === "important" || stored === "mute") {
        return stored;
      }
    } catch {
      // localStorage unavailable
    }
    return DEFAULT_LEVEL;
  }

  /** Persist notification level to localStorage */
  setLevel(level: NotificationLevel): void {
    try {
      localStorage.setItem(NOTIFICATION_LEVEL_KEY, level);
    } catch {
      // localStorage unavailable
    }
  }

  /**
   * Send a desktop notification with level filtering and dedup.
   * Suppresses notifications when the application window is focused.
   *
   * @param type - Notification classification
   * @param title - Notification title
   * @param body - Notification body text
   * @param sessionId - Session ID for dedup tracking
   * @param onClick - Callback when user clicks the notification
   */
  async send(
    type: NotificationType,
    title: string,
    body: string,
    sessionId: string,
    onClick?: () => void,
  ): Promise<void> {
    // 0. Suppress if window is visible (user is actively using the app)
    if (this.isWindowVisible) {
      console.log("[Notification] Suppressed (window visible):", { type, title, sessionId });
      return;
    }
    
    console.log("[Notification] Processing:", { type, title, sessionId, isWindowVisible: this.isWindowVisible });

    // 1. Level filter
    const level = this.getLevel();
    if (!LEVEL_ALLOWS[level].has(type)) {
      return;
    }

    // 2. Throttle: task_completed dedup within 5s window per session
    if (type === "task_completed") {
      const now = Date.now();
      const lastTime = this.lastNotified.get(sessionId);
      if (lastTime && now - lastTime < THROTTLE_WINDOW_MS) {
        return; // suppress duplicate
      }
      this.lastNotified.set(sessionId, now);
    }

    // 3. Check notification permission (respecting permission policy)
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        const policy = getPermissionPolicy();
        if (policy === "bypass" || policy === "batch") {
          // In bypass/batch mode, don't trigger the OS permission dialog.
          // If not already granted, silently skip sending.
          return;
        }
        const permission = await requestPermission();
        granted = permission === "granted";
      }
      if (!granted) return;
    } catch {
      // Notification API not available (e.g., browser mode)
      return;
    }

    // 4. Create and show notification
    try {
      const notification = new Notification(title, {
        body: body || undefined,
        silent: false,
      });

      if (onClick) {
        notification.onclick = () => {
          try {
            onClick();
          } catch {
            // Ignore click handler errors
          }
        };
      }
    } catch {
      // Notification constructor not available
    }
  }
}

/** Singleton instance */
export const notificationService = new NotificationService();
