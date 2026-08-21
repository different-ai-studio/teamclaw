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
  _resetCloudApiUrlCacheForTests,
  bundledCloudApiUrl,
  getCloudApiUrlOverride,
  hasCloudApiUrlOverride,
  hydrateCloudApiUrl,
  setCloudApiUrlOverride,
} from "../lib/cloud-api/cloud-api-url";
import { cloudApiBaseUrl } from "../lib/cloud-api/client";
import {
  normalizeServerEndpoint,
  probeServerEndpoint,
} from "../lib/cloud-api/server-endpoint";

describe("normalizeServerEndpoint", () => {
  it("defaults scheme to https", () => {
    expect(normalizeServerEndpoint("api.example.com")).toBe("https://api.example.com");
  });

  it("keeps explicit http and port", () => {
    expect(normalizeServerEndpoint("http://192.168.1.10:8787")).toBe(
      "http://192.168.1.10:8787",
    );
  });

  it("trims whitespace and trailing slashes", () => {
    expect(normalizeServerEndpoint("  https://api.example.com//  ")).toBe(
      "https://api.example.com",
    );
  });

  it("keeps path prefix", () => {
    expect(normalizeServerEndpoint("https://example.com/teamclu/")).toBe(
      "https://example.com/teamclu",
    );
  });

  it("strips query and fragment", () => {
    expect(normalizeServerEndpoint("https://api.example.com/?ref=x")).toBe(
      "https://api.example.com",
    );
    expect(normalizeServerEndpoint("https://example.com/base?a=1#frag")).toBe(
      "https://example.com/base",
    );
  });

  it("rejects garbage", () => {
    expect(normalizeServerEndpoint("")).toBeNull();
    expect(normalizeServerEndpoint("   ")).toBeNull();
    expect(normalizeServerEndpoint("ftp://example.com")).toBeNull();
    expect(normalizeServerEndpoint("https://")).toBeNull();
  });
});

describe("probeServerEndpoint", () => {
  it("reports reachable on HTTP 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });
    await expect(
      probeServerEndpoint("https://api.example.com", { fetchImpl }),
    ).resolves.toEqual({ kind: "reachable" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.example.com/v1/config/public",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reports badStatus for non-200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 404 });
    await expect(
      probeServerEndpoint("https://api.example.com", { fetchImpl }),
    ).resolves.toEqual({ kind: "badStatus", status: 404 });
  });

  it("reports unreachable on network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Network request failed"));
    await expect(
      probeServerEndpoint("https://api.example.com", { fetchImpl }),
    ).resolves.toEqual({
      kind: "unreachable",
      reason: "Network request failed",
    });
  });
});

describe("cloud API URL override", () => {
  beforeEach(() => {
    (AsyncStorage as unknown as { _reset: () => void })._reset();
    _resetCloudApiUrlCacheForTests();
    vi.stubEnv("EXPO_PUBLIC_CLOUD_API_URL", "https://api.teamclu-dev.ucar.cc");
    vi.clearAllMocks();
  });

  it("hydrates a persisted override into cloudApiBaseUrl", async () => {
    await AsyncStorage.setItem(
      "teamclu.cloudApiUrl.override",
      "https://self.example.com",
    );
    await hydrateCloudApiUrl();
    expect(hasCloudApiUrlOverride()).toBe(true);
    expect(getCloudApiUrlOverride()).toBe("https://self.example.com");
    expect(cloudApiBaseUrl()).toBe("https://self.example.com");
  });

  it("falls back to the bundled env URL when no override", async () => {
    await hydrateCloudApiUrl();
    expect(hasCloudApiUrlOverride()).toBe(false);
    expect(cloudApiBaseUrl()).toBe("https://api.teamclu-dev.ucar.cc");
    expect(bundledCloudApiUrl()).toBe("https://api.teamclu-dev.ucar.cc");
  });

  it("round-trips set/clear and treats bundled default as clear", async () => {
    await hydrateCloudApiUrl();
    await setCloudApiUrlOverride("https://self.example.com");
    expect(cloudApiBaseUrl()).toBe("https://self.example.com");
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      "teamclu.cloudApiUrl.override",
      "https://self.example.com",
    );

    await setCloudApiUrlOverride("https://api.teamclu-dev.ucar.cc");
    expect(hasCloudApiUrlOverride()).toBe(false);
    expect(cloudApiBaseUrl()).toBe("https://api.teamclu-dev.ucar.cc");
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(
      "teamclu.cloudApiUrl.override",
    );
  });

  it("drops a corrupt persisted override on hydrate", async () => {
    await AsyncStorage.setItem("teamclu.cloudApiUrl.override", "ftp://nope");
    await hydrateCloudApiUrl();
    expect(hasCloudApiUrlOverride()).toBe(false);
    expect(cloudApiBaseUrl()).toBe("https://api.teamclu-dev.ucar.cc");
  });
});
