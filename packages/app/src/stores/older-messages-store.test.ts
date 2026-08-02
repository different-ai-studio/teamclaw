import { describe, it, expect, vi, beforeEach } from "vitest";

const listMessagePage = vi.fn();
const upsertMessagesBatch = vi.fn().mockResolvedValue(undefined);
const loadMessagesForSession = vi.fn().mockResolvedValue([]);
const setMessages = vi.fn();

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({ kind: "cloud_api", messages: { listMessagePage } }),
}));
vi.mock("@/lib/local-cache", () => ({
  upsertMessagesBatch: (...args: unknown[]) => upsertMessagesBatch(...args),
  loadMessagesForSession: (...args: unknown[]) => loadMessagesForSession(...args),
}));
vi.mock("@/lib/message-history-map", () => ({ historyRowsToMessageRows: (rows: unknown[]) => rows }));
vi.mock("@/lib/session-export/collect", () => ({ messageRowsToProto: (rows: unknown[]) => rows }));
vi.mock("@/stores/session-message-store", () => ({
  useSessionMessageStore: { getState: () => ({ setMessages }) },
}));
vi.mock("@/stores/session-list-store", () => ({
  useSessionListStore: { getState: () => ({ rows: [{ id: "s1", team_id: "team-1" }] }) },
}));

const { useOlderMessagesStore } = await import("./older-messages-store");

describe("older-messages store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOlderMessagesStore.setState({ cursorBySession: {}, loadingBySession: {} });
  });

  it("does nothing when no cursor is known for the session", async () => {
    await useOlderMessagesStore.getState().loadOlder("s1");
    expect(listMessagePage).not.toHaveBeenCalled();
  });

  it("fetches the next-older page, writes it through the cache, and advances the cursor", async () => {
    listMessagePage.mockResolvedValueOnce({ rows: [{ id: "m1" }], nextCursor: "older-2" });
    useOlderMessagesStore.getState().setCursor("s1", "older-1");

    await useOlderMessagesStore.getState().loadOlder("s1");

    expect(listMessagePage).toHaveBeenCalledWith("s1", { limit: 50, cursor: "older-1" });
    // Written through the cache the timeline reads from, so older rows survive
    // a session switch instead of being re-fetched.
    expect(upsertMessagesBatch).toHaveBeenCalledWith([{ id: "m1" }]);
    expect(setMessages).toHaveBeenCalled();
    expect(useOlderMessagesStore.getState().cursorBySession.s1).toBe("older-2");
  });

  it("stops offering more once the server reports the start of history", async () => {
    listMessagePage.mockResolvedValueOnce({ rows: [], nextCursor: null });
    useOlderMessagesStore.getState().setCursor("s1", "older-1");

    await useOlderMessagesStore.getState().loadOlder("s1");

    expect(useOlderMessagesStore.getState().cursorBySession.s1).toBeNull();
    await useOlderMessagesStore.getState().loadOlder("s1");
    expect(listMessagePage).toHaveBeenCalledTimes(1);
  });

  it("keeps the cursor and clears the spinner when the fetch fails, so a retry works", async () => {
    listMessagePage.mockRejectedValueOnce(new Error("network"));
    useOlderMessagesStore.getState().setCursor("s1", "older-1");

    await useOlderMessagesStore.getState().loadOlder("s1");

    expect(useOlderMessagesStore.getState().cursorBySession.s1).toBe("older-1");
    expect(useOlderMessagesStore.getState().loadingBySession.s1).toBe(false);
    expect(setMessages).not.toHaveBeenCalled();
  });
});
