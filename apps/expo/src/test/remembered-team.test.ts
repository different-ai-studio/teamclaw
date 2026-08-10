import { describe, expect, it, vi } from "vitest";

import { createRememberedTeamStore } from "../features/onboarding/remembered-team";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: vi.fn(async (k: string) => map.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      map.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      map.delete(k);
    }),
  };
}

describe("remembered team", () => {
  it("round-trips the chosen team", async () => {
    const storage = memoryStorage();
    const store = createRememberedTeamStore(storage);
    await store.save("team-2");
    expect(await store.load()).toBe("team-2");
  });

  it("reads nothing before a choice is made", async () => {
    expect(await createRememberedTeamStore(memoryStorage()).load()).toBeNull();
  });

  it("treats a blank stored value as no choice", async () => {
    const store = createRememberedTeamStore(memoryStorage({
      "teamclu.onboarding.rememberedTeamId": "   ",
    }));
    expect(await store.load()).toBeNull();
  });

  it("refuses to remember a blank id", async () => {
    const storage = memoryStorage();
    await createRememberedTeamStore(storage).save("  ");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("clears on sign-out so the next user does not inherit it", async () => {
    const storage = memoryStorage();
    const store = createRememberedTeamStore(storage);
    await store.save("team-2");
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("survives storage that throws — a lost preference costs one tap", async () => {
    const broken = {
      getItem: vi.fn(async () => {
        throw new Error("nope");
      }),
      setItem: vi.fn(async () => {
        throw new Error("nope");
      }),
      removeItem: vi.fn(async () => {
        throw new Error("nope");
      }),
    };
    const store = createRememberedTeamStore(broken);
    await expect(store.load()).resolves.toBeNull();
    await expect(store.save("team-1")).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
