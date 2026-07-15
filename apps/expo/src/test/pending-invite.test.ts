import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      _reset() {
        store.clear();
      },
    },
  };
});

import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  clearPendingInviteToken,
  loadPendingInviteToken,
  savePendingInviteToken,
} from "../features/onboarding/pending-invite";

describe("pending invite token", () => {
  beforeEach(() => {
    (AsyncStorage as unknown as { _reset: () => void })._reset();
    vi.clearAllMocks();
  });

  it("returns null when nothing was saved", async () => {
    expect(await loadPendingInviteToken()).toBeNull();
  });

  it("round-trips a token through save/load", async () => {
    await savePendingInviteToken("tok-1");
    expect(await loadPendingInviteToken()).toBe("tok-1");
  });

  it("ignores empty / whitespace-only saves", async () => {
    await savePendingInviteToken("   ");
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(await loadPendingInviteToken()).toBeNull();
  });

  it("clearing removes the token", async () => {
    await savePendingInviteToken("tok-2");
    await clearPendingInviteToken();
    expect(await loadPendingInviteToken()).toBeNull();
  });

  it("treats a stored empty string as no token", async () => {
    await AsyncStorage.setItem("teamclaw.pendingInviteToken.v1", "   ");
    expect(await loadPendingInviteToken()).toBeNull();
  });
});
