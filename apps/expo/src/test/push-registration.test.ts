import { describe, expect, it, vi } from "vitest";

import { registerNativePushToken } from "../features/notifications/push-registration";

function createNotifications(overrides: object = {}) {
  return {
    getPermissionsAsync: vi.fn().mockResolvedValue({ status: "undetermined" }),
    requestPermissionsAsync: vi.fn().mockResolvedValue({ status: "granted" }),
    getDevicePushTokenAsync: vi.fn().mockResolvedValue({ type: "ios", data: "APNS" }),
    ...overrides,
  };
}

describe("registerNativePushToken", () => {
  it("requests permission and uploads an iOS APNs token", async () => {
    const notifications = createNotifications();
    const api = { upload: vi.fn().mockResolvedValue(undefined) };

    const result = await registerNativePushToken({
      notifications,
      api,
      userId: "user-1",
      deviceId: "device-1",
      platform: "ios",
      appVersion: "0.1.0",
    });

    expect(result).toEqual({ status: "registered", provider: "apns" });
    expect(notifications.requestPermissionsAsync).toHaveBeenCalled();
    expect(api.upload).toHaveBeenCalledWith({
      userId: "user-1",
      deviceId: "device-1",
      platform: "ios",
      provider: "apns",
      token: "APNS",
      appVersion: "0.1.0",
    });
  });

  it("does not ask for a token when notification permission is denied", async () => {
    const notifications = createNotifications({
      requestPermissionsAsync: vi.fn().mockResolvedValue({ status: "denied" }),
    });
    const api = { upload: vi.fn().mockResolvedValue(undefined) };

    const result = await registerNativePushToken({
      notifications,
      api,
      userId: "user-1",
      deviceId: "device-1",
      platform: "ios",
    });

    expect(result).toEqual({ status: "skipped", reason: "permission_denied" });
    expect(notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    expect(api.upload).not.toHaveBeenCalled();
  });

  it("skips Android until the backend can deliver FCM tokens", async () => {
    const notifications = createNotifications();
    const api = { upload: vi.fn().mockResolvedValue(undefined) };

    const result = await registerNativePushToken({
      notifications,
      api,
      userId: "user-1",
      deviceId: "device-1",
      platform: "android",
    });

    expect(result).toEqual({ status: "skipped", reason: "unsupported_platform" });
    expect(notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(api.upload).not.toHaveBeenCalled();
  });
});
