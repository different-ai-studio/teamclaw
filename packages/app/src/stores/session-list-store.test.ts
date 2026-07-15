import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "./auth-store";

const mocks = vi.hoisted(() => ({
  listCurrentActorSessions: vi.fn(),
  markCurrentActorSessionViewed: vi.fn(),
  updateSessionTitle: vi.fn(),
  archiveSession: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    sessions: {
      listCurrentActorSessions: mocks.listCurrentActorSessions,
      markCurrentActorSessionViewed: mocks.markCurrentActorSessionViewed,
      updateSessionTitle: mocks.updateSessionTitle,
      archiveSession: mocks.archiveSession,
    },
  }),
}));

vi.mock("@/lib/utils", () => ({
  isTauri: () => false,
}));

const sessionRow = (overrides: Partial<{
  id: string;
  title: string;
  last_message_at: string | null;
  created_at: string;
  has_unread: boolean;
}> = {}) => ({
  id: "session-1",
  title: "Session",
  team_id: "team-1",
  mode: "collab",
  idea_id: null,
  last_message_at: "2026-05-17T08:00:00.000Z",
  last_message_preview: "preview",
  created_at: "2026-05-17T07:59:00.000Z",
  updated_at: "2026-05-17T08:00:01.000Z",
  has_unread: false,
  ...overrides,
});

describe("session-list-store", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useSessionListStore } = await import("./session-list-store");
    useSessionListStore.setState({
      rows: [],
      loading: false,
      error: null,
      pinnedSessionIds: [],
      highlightedSessionIds: [],
      hasMore: false,
      nextCursor: null,
    });
    useAuthStore.setState({
      session: { user: { id: "user-1" } },
      loading: false,
      errorMessage: null,
      otpEmail: null,
    } as never);
  });

  it("loads the first page from the current actor session RPC", async () => {
    mocks.listCurrentActorSessions.mockResolvedValueOnce({
      rows: [sessionRow({ has_unread: true })],
    });

    const { useSessionListStore } = await import("./session-list-store");
    await useSessionListStore.getState().loadFirstPage();

    expect(mocks.listCurrentActorSessions).toHaveBeenCalledWith({
      limit: 50,
      cursor: null,
    });
    expect(useSessionListStore.getState().rows[0]).toMatchObject({
      id: "session-1",
      has_unread: true,
    });
  });

  it("loads more with the last row composite cursor and dedupes rows", async () => {
    mocks.listCurrentActorSessions
      .mockResolvedValueOnce({
        rows: [
          sessionRow({
            id: "session-1",
            last_message_at: "2026-05-17T08:00:00.000Z",
            created_at: "2026-05-17T07:59:00.000Z",
          }),
          sessionRow({
            id: "session-2",
            last_message_at: "2026-05-17T07:00:00.000Z",
            created_at: "2026-05-17T06:59:00.000Z",
          }),
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          sessionRow({
            id: "session-2",
            last_message_at: "2026-05-17T07:00:00.000Z",
            created_at: "2026-05-17T06:59:00.000Z",
          }),
          sessionRow({
            id: "session-3",
            last_message_at: "2026-05-17T06:00:00.000Z",
            created_at: "2026-05-17T05:59:00.000Z",
          }),
        ],
      });

    const { useSessionListStore } = await import("./session-list-store");
    await useSessionListStore.getState().loadFirstPage(2);
    await useSessionListStore.getState().loadMore(2);

    expect(mocks.listCurrentActorSessions).toHaveBeenLastCalledWith({
      limit: 2,
      cursor: {
        lastMessageAt: "2026-05-17T07:00:00.000Z",
        createdAt: "2026-05-17T06:59:00.000Z",
        id: "session-2",
      },
    });
    expect(useSessionListStore.getState().rows.map((row) => row.id)).toEqual([
      "session-1",
      "session-2",
      "session-3",
    ]);
  });

  it("uses the backend next cursor instead of inferring hasMore from row count", async () => {
    mocks.listCurrentActorSessions.mockResolvedValueOnce({
      rows: [
        sessionRow({
          id: "session-1",
          last_message_at: "2026-05-17T08:00:00.000Z",
          created_at: "2026-05-17T07:59:00.000Z",
        }),
        sessionRow({
          id: "session-2",
          last_message_at: "2026-05-17T07:00:00.000Z",
          created_at: "2026-05-17T06:59:00.000Z",
        }),
      ],
      nextCursor: null,
    });

    const { useSessionListStore } = await import("./session-list-store");
    await useSessionListStore.getState().loadFirstPage(2);

    expect(useSessionListStore.getState().hasMore).toBe(false);
    expect(useSessionListStore.getState().nextCursor).toBeNull();
  });

  it("marks the current actor session viewed and clears local unread state", async () => {
    mocks.markCurrentActorSessionViewed.mockResolvedValueOnce(undefined);

    const { useSessionListStore } = await import("./session-list-store");
    useSessionListStore.setState({
      rows: [sessionRow({ has_unread: true })],
    });

    await useSessionListStore.getState().markSessionViewed("session-1");

    expect(mocks.markCurrentActorSessionViewed).toHaveBeenCalledWith("session-1", null);
    expect(useSessionListStore.getState().rows[0].has_unread).toBe(false);
  });

  it("renames a session through the backend and patches the row", async () => {
    mocks.updateSessionTitle.mockResolvedValueOnce(undefined);

    const { useSessionListStore } = await import("./session-list-store");
    useSessionListStore.setState({ rows: [sessionRow()] });

    await useSessionListStore.getState().updateSessionTitle("session-1", "Renamed");

    expect(mocks.updateSessionTitle).toHaveBeenCalledWith("session-1", "Renamed");
    expect(useSessionListStore.getState().rows[0].title).toBe("Renamed");
  });

  it("omits locally remembered archived ids from hydrated rows", async () => {
    localStorage.setItem(
      "teamclaw.sessionList.archivedIds",
      JSON.stringify(["session-archived"]),
    );
    mocks.listCurrentActorSessions.mockResolvedValueOnce({
      rows: [
        sessionRow({ id: "session-archived" }),
        sessionRow({ id: "session-active" }),
      ],
    });

    const { useSessionListStore } = await import("./session-list-store");
    await useSessionListStore.getState().loadFirstPage();

    expect(useSessionListStore.getState().rows.map((row) => row.id)).toEqual([
      "session-active",
    ]);
    localStorage.removeItem("teamclaw.sessionList.archivedIds");
  });

  it("archives a session through the backend and removes the row", async () => {
    mocks.archiveSession.mockResolvedValueOnce(undefined);

    const { useSessionListStore } = await import("./session-list-store");
    useSessionListStore.setState({ rows: [sessionRow()] });

    await useSessionListStore.getState().archiveSession("session-1");

    expect(mocks.archiveSession).toHaveBeenCalledWith("session-1", expect.any(String));
    expect(useSessionListStore.getState().rows).toEqual([]);
    expect(
      JSON.parse(localStorage.getItem("teamclaw.sessionList.archivedIds") ?? "[]"),
    ).toContain("session-1");
    localStorage.removeItem("teamclaw.sessionList.archivedIds");
  });
});
