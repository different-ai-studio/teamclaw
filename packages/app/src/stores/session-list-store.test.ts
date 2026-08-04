import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "./auth-store";
import { useCurrentTeamStore } from "./current-team";

const mocks = vi.hoisted(() => ({
  listCurrentActorSessions: vi.fn(),
  markCurrentActorSessionViewed: vi.fn(),
  updateSessionTitle: vi.fn(),
  archiveSession: vi.fn(),
  toastError: vi.fn(),
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

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

vi.mock("@/lib/i18n", () => ({
  default: { t: (key: string) => key },
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
    localStorage.clear();
    const { useSessionListStore } = await import("./session-list-store");
    useSessionListStore.setState({
      rows: [],
      loading: false,
      error: null,
      pinnedSessionIds: [],
      highlightedSessionIds: [],
      hasMore: false,
      nextCursor: null,
      serverConfirmed: false,
      scopeTeamId: null,
    });
    useCurrentTeamStore.setState({
      team: { id: "team-1", name: "Team", slug: "team" },
    } as never);
    useAuthStore.setState({
      session: { user: { id: "user-1" } },
      loading: false,
      errorMessage: null,
      otpEmail: null,
    } as never);
  });

  it("sorts rows by last_message_at desc with nulls first after load", async () => {
    mocks.listCurrentActorSessions.mockResolvedValueOnce({
      rows: [
        sessionRow({
          id: "empty-old",
          last_message_at: null,
          created_at: "2026-07-21T02:00:00.000Z",
        }),
        sessionRow({
          id: "recent",
          last_message_at: "2026-07-21T10:00:00.000Z",
          created_at: "2026-07-21T09:00:00.000Z",
        }),
        sessionRow({
          id: "older",
          last_message_at: "2026-07-21T09:00:00.000Z",
          created_at: "2026-07-21T08:30:00.000Z",
        }),
      ],
    });

    const { useSessionListStore } = await import("./session-list-store");
    await useSessionListStore.getState().loadFirstPage();

    expect(useSessionListStore.getState().rows.map((row) => row.id)).toEqual([
      "empty-old",
      "recent",
      "older",
    ]);
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
      teamId: "team-1",
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
      teamId: "team-1",
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

  // This used to assert the opposite — that a locally remembered archived id is
  // dropped from hydrated rows no matter where the row came from. The list RPC
  // only returns rows with `archived_at is null`, so a row arriving from the
  // server is positive evidence that it was un-archived elsewhere: by another
  // device, or by the gateway when a new message lands on the chat. Keeping it
  // hidden would strand a demonstrably live session behind a stale local flag,
  // since the local list only ever grew.
  //
  // The filter still applies to libsql cache rows, which are not evidence of
  // anything — archived sessions sit there until they are soft deleted. That
  // path is unreachable here because these tests mock isTauri() to false.
  it("un-hides a remembered archived id when the server returns it again", async () => {
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
      "session-archived",
      "session-active",
    ]);
    // and the stale id is forgotten, so it cannot hide the session on the next
    // cold boot either.
    expect(
      JSON.parse(localStorage.getItem("teamclaw.sessionList.archivedIds") ?? "[]"),
    ).toEqual([]);
    localStorage.removeItem("teamclaw.sessionList.archivedIds");
  });

  it("keeps hiding a remembered archived id the server does not return", async () => {
    localStorage.setItem(
      "teamclaw.sessionList.archivedIds",
      JSON.stringify(["session-archived"]),
    );
    mocks.listCurrentActorSessions.mockResolvedValueOnce({
      rows: [sessionRow({ id: "session-active" })],
    });

    const { useSessionListStore } = await import("./session-list-store");
    await useSessionListStore.getState().loadFirstPage();

    expect(useSessionListStore.getState().rows.map((row) => row.id)).toEqual([
      "session-active",
    ]);
    expect(
      JSON.parse(localStorage.getItem("teamclaw.sessionList.archivedIds") ?? "[]"),
    ).toEqual(["session-archived"]);
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

  // Every visibility gate on GET /v1/sessions fails closed with 200 + an empty
  // list (no actor for the caller, no session_participants row, RLS), so an
  // empty page is not evidence that the user has no sessions until the server
  // has proved it can see them at least once.
  it("keeps rows already on screen when the first server page comes back empty", async () => {
    mocks.listCurrentActorSessions.mockResolvedValueOnce({ rows: [] });

    const { useSessionListStore } = await import("./session-list-store");
    useSessionListStore.setState({ rows: [sessionRow({ id: "cached-1" })] });

    await useSessionListStore.getState().loadFirstPage();

    expect(useSessionListStore.getState().rows.map((row) => row.id)).toEqual(["cached-1"]);
    expect(useSessionListStore.getState().loading).toBe(false);
    expect(useSessionListStore.getState().hasMore).toBe(false);
    // Not an error — no toast for this path, or the debounced refresh would
    // toast on every tick.
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("empties the list on an empty page once the server has returned rows", async () => {
    mocks.listCurrentActorSessions
      .mockResolvedValueOnce({ rows: [sessionRow({ id: "session-1" })] })
      .mockResolvedValueOnce({ rows: [] });

    const { useSessionListStore } = await import("./session-list-store");
    await useSessionListStore.getState().loadFirstPage();
    expect(useSessionListStore.getState().serverConfirmed).toBe(true);

    await useSessionListStore.getState().loadFirstPage();

    expect(useSessionListStore.getState().rows).toEqual([]);
  });

  it("toasts when the list refresh fails", async () => {
    mocks.listCurrentActorSessions.mockRejectedValueOnce(new Error("boom"));

    const { useSessionListStore } = await import("./session-list-store");
    useSessionListStore.setState({ rows: [sessionRow({ id: "cached-1" })] });

    await useSessionListStore.getState().loadFirstPage();

    // The rows on screen survive a failed refresh; the toast is what tells the
    // user they may now be stale.
    expect(useSessionListStore.getState().rows.map((row) => row.id)).toEqual(["cached-1"]);
    expect(useSessionListStore.getState().error).toBe("boom");
    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("sessions.list.refreshFailed", {
        id: "session-list-refresh-failed",
        description: "boom",
      }),
    );
  });

  // ── team scoping ────────────────────────────────────────────────────────

  it("drops the previous team's rows before the new team's page arrives", async () => {
    const { useSessionListStore } = await import("./session-list-store");
    useSessionListStore.setState({
      rows: [sessionRow({ id: "team-1-session" })],
      scopeTeamId: "team-1",
      serverConfirmed: true,
    });
    useCurrentTeamStore.setState({
      team: { id: "team-2", name: "Other", slug: "other" },
    } as never);

    let rowsDuringFetch: string[] = [];
    mocks.listCurrentActorSessions.mockImplementationOnce(async () => {
      rowsDuringFetch = useSessionListStore.getState().rows.map((row) => row.id);
      return { rows: [{ ...sessionRow({ id: "team-2-session" }), team_id: "team-2" }] };
    });

    await useSessionListStore.getState().loadFirstPage();

    // The list must not show the team being left while the switch is in flight.
    expect(rowsDuringFetch).toEqual([]);
    expect(useSessionListStore.getState().rows.map((row) => row.id)).toEqual([
      "team-2-session",
    ]);
    expect(useSessionListStore.getState().scopeTeamId).toBe("team-2");
  });

  // The empty-response guard keys on "the server has proved it can see rows".
  // That proof belongs to a team: the previous team's rows say nothing about
  // whether this one is visible, and carrying the flag over would let an empty
  // page for the new team be taken at face value.
  it("re-arms the empty-response guard on a team switch", async () => {
    const { useSessionListStore } = await import("./session-list-store");
    useSessionListStore.setState({
      rows: [sessionRow({ id: "team-1-session" })],
      scopeTeamId: "team-1",
      serverConfirmed: true,
    });
    useCurrentTeamStore.setState({
      team: { id: "team-2", name: "Other", slug: "other" },
    } as never);
    mocks.listCurrentActorSessions.mockResolvedValueOnce({ rows: [] });

    await useSessionListStore.getState().loadFirstPage();

    expect(useSessionListStore.getState().serverConfirmed).toBe(false);
  });

  it("keeps the scope on loadMore so page 2 cannot widen the list", async () => {
    const { useSessionListStore } = await import("./session-list-store");
    mocks.listCurrentActorSessions
      .mockResolvedValueOnce({ rows: [sessionRow({ id: "session-1" })] })
      .mockResolvedValueOnce({ rows: [] });

    await useSessionListStore.getState().loadFirstPage(1);
    await useSessionListStore.getState().loadMore(1);

    expect(mocks.listCurrentActorSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ teamId: "team-1" }),
    );
  });

  // MQTT subscribes to every team's live topic, and open-session-deeplink seeds
  // a row for the team it is about to switch into — both write straight into
  // the store.
  it("ignores upserted rows from another team", async () => {
    const { useSessionListStore } = await import("./session-list-store");
    useSessionListStore.setState({ rows: [], scopeTeamId: "team-1" });

    useSessionListStore.getState().upsertRows([
      sessionRow({ id: "mine" }),
      { ...sessionRow({ id: "theirs" }), team_id: "team-2" },
    ]);

    expect(useSessionListStore.getState().rows.map((row) => row.id)).toEqual(["mine"]);
  });

  it("shares one request between concurrent first-page loads of the same team", async () => {
    const { useSessionListStore } = await import("./session-list-store");
    mocks.listCurrentActorSessions.mockResolvedValue({
      rows: [sessionRow({ id: "session-1" })],
    });

    await Promise.all([
      useSessionListStore.getState().loadFirstPage(),
      useSessionListStore.getState().loadFirstPage(),
      useSessionListStore.getState().load(),
    ]);

    expect(mocks.listCurrentActorSessions).toHaveBeenCalledTimes(1);
  });
});
