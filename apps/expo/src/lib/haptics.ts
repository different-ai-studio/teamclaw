import * as Haptics from "expo-haptics";

/**
 * Thin wrappers over expo-haptics that mirror the iOS UIImpactFeedback
 * intensities the original app uses. All calls are best-effort —
 * Haptics is a no-op on devices that don't support it.
 */
export function selectionTick(): void {
  void Haptics.selectionAsync().catch(() => {});
}

export function impactLight(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export function impactMedium(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

export function successTone(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(
    () => {},
  );
}

export function warningTone(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
    () => {},
  );
}

export function errorTone(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
    () => {},
  );
}
