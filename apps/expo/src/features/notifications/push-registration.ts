import type { PushTokenApi } from "./push-token-api";

export type NativePushPlatform = "ios" | "android" | "desktop" | "web" | string;

export type NativePushNotificationsAdapter = {
  getPermissionsAsync: () => Promise<NotificationPermissionLike>;
  requestPermissionsAsync: () => Promise<NotificationPermissionLike>;
  getDevicePushTokenAsync: () => Promise<{ data?: unknown; type?: string }>;
};

export type NotificationPermissionLike = {
  granted?: boolean;
  status?: string;
};

export type PushRegistrationResult =
  | { status: "registered"; provider: "apns" }
  | {
      status: "skipped";
      reason:
        | "missing_identity"
        | "permission_denied"
        | "unsupported_platform"
        | "empty_token";
    };

export async function registerNativePushToken({
  notifications,
  api,
  userId,
  deviceId,
  platform,
  appVersion = null,
}: {
  notifications: NativePushNotificationsAdapter;
  api: Pick<PushTokenApi, "upload">;
  userId: string | null | undefined;
  deviceId: string | null | undefined;
  platform: NativePushPlatform;
  appVersion?: string | null;
}): Promise<PushRegistrationResult> {
  if (!userId || !deviceId) return { status: "skipped", reason: "missing_identity" };
  if (platform !== "ios") {
    return { status: "skipped", reason: "unsupported_platform" };
  }

  const existingPermission = await notifications.getPermissionsAsync();
  const permission = isGranted(existingPermission)
    ? existingPermission
    : await notifications.requestPermissionsAsync();
  if (!isGranted(permission)) {
    return { status: "skipped", reason: "permission_denied" };
  }

  const tokenResult = await notifications.getDevicePushTokenAsync();
  const token = typeof tokenResult.data === "string" ? tokenResult.data.trim() : "";
  if (!token) return { status: "skipped", reason: "empty_token" };

  await api.upload({
    userId,
    deviceId,
    platform: "ios",
    provider: "apns",
    token,
    appVersion,
  });
  return { status: "registered", provider: "apns" };
}

function isGranted(permission: NotificationPermissionLike): boolean {
  return permission.granted === true || permission.status === "granted";
}
