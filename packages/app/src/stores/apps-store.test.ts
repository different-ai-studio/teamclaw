import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  createApp: vi.fn(),
  updateAppProvisionStatus: vi.fn(),
  seedDaemonApp: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    apps: {
      listApps: mocks.listApps,
      createApp: mocks.createApp,
      updateAppProvisionStatus: mocks.updateAppProvisionStatus,
    },
  }),
}));

vi.mock("@/lib/daemon-local-client", () => ({
  seedDaemonApp: mocks.seedDaemonApp,
}));

const appRow = (over = {}) => ({
  id: "app-1",
  teamId: "team-1",
  name: "App",
  slug: "app",
  type: "fullstack_tanstack_postgres",
  visibility: "team",
  workspaceId: "ws-1",
  gitRemoteUrl: null,
  provisionStatus: "pending",
  fcStatus: null,
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z",
  ...over,
});

describe("apps-store", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.seedDaemonApp.mockResolvedValue("unreachable");
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({
      items: [],
      loaded: false,
      loading: false,
      error: null,
      teamId: null,
    });
  });

  it("loads apps for a team (cache-first: skips reload when loaded)", async () => {
    mocks.listApps.mockResolvedValueOnce([appRow({ name: "Alpha" })]);
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().load("team-1");
    expect(useAppsStore.getState().items[0]).toMatchObject({
      id: "app-1",
      name: "Alpha",
    });

    await useAppsStore.getState().load("team-1"); // cached → no second call
    expect(mocks.listApps).toHaveBeenCalledTimes(1);
  });

  it("force reload calls the backend again", async () => {
    mocks.listApps.mockResolvedValue([appRow()]);
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().load("team-1");
    await useAppsStore.getState().load("team-1", { force: true });
    expect(mocks.listApps).toHaveBeenCalledTimes(2);
  });

  it("create prepends the new app and returns it", async () => {
    mocks.createApp.mockResolvedValueOnce(appRow({ id: "app-2", name: "New" }));
    const { useAppsStore } = await import("./apps-store");
    const row = await useAppsStore.getState().create({
      teamId: "team-1",
      name: "New",
      type: "fullstack_tanstack_postgres",
      visibility: "personal",
    });
    expect(row.id).toBe("app-2");
    expect(useAppsStore.getState().items[0]).toMatchObject({ id: "app-2" });
  });

  it("does NOT kick the daemon seed when repo is not yet created", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ id: "app-4", provisionStatus: "pending", gitRemoteUrl: null }),
    );
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "Pending",
      type: "fullstack_tanstack_postgres",
      visibility: "team",
    });
    expect(mocks.seedDaemonApp).not.toHaveBeenCalled();
  });

  it("does NOT kick the daemon seed when repo_created but gitRemoteUrl is missing", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ id: "app-5", provisionStatus: "repo_created", gitRemoteUrl: null }),
    );
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "NoUrl",
      type: "fullstack_tanstack_postgres",
      visibility: "team",
    });
    expect(mocks.seedDaemonApp).not.toHaveBeenCalled();
  });

  it("create: seeded → PATCH ready", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "repo_created", gitRemoteUrl: "https://g/x.git", teamId: "team-1" }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
    mocks.seedDaemonApp.mockResolvedValueOnce("seeded");
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "fullstack_tanstack_postgres",
      visibility: "team",
    });
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith("app-1", "https://g/x.git", "team-1");
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("create: failed → PATCH error", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "repo_created", gitRemoteUrl: "https://g/x.git", teamId: "team-1" }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
    mocks.seedDaemonApp.mockResolvedValueOnce("failed");
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "fullstack_tanstack_postgres",
      visibility: "team",
    });
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["error"]);
  });

  it("create: unreachable → no status PATCH (stays repo_created)", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "repo_created", gitRemoteUrl: "https://g/x.git", teamId: "team-1" }),
    );
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
    mocks.seedDaemonApp.mockResolvedValueOnce("unreachable");
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "fullstack_tanstack_postgres",
      visibility: "team",
    });
    expect(mocks.updateAppProvisionStatus).not.toHaveBeenCalled();
  });

  it("reseed: re-runs seed for an existing app (error → seeded → ready)", async () => {
    mocks.updateAppProvisionStatus.mockImplementation(async (_id, s) => appRow({ provisionStatus: s }));
    mocks.seedDaemonApp.mockResolvedValueOnce("seeded");
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({
      items: [appRow({ provisionStatus: "error", gitRemoteUrl: "https://g/x.git", teamId: "team-1" })],
      loaded: true,
      loading: false,
      error: null,
      teamId: "team-1",
    });
    await useAppsStore.getState().reseed("app-1");
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith("app-1", "https://g/x.git", "team-1");
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("create: a thrown status PATCH does not reject create", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "repo_created", gitRemoteUrl: "https://g/x.git", teamId: "team-1" }),
    );
    mocks.updateAppProvisionStatus.mockRejectedValue(new Error("boom"));
    mocks.seedDaemonApp.mockResolvedValueOnce("seeded");
    const { useAppsStore } = await import("./apps-store");
    const row = await useAppsStore.getState().create({
      teamId: "team-1",
      name: "N",
      type: "fullstack_tanstack_postgres",
      visibility: "team",
    });
    expect(row.id).toBe("app-1");
  });

  it("a thrown daemon seed error does NOT reject create (app is still returned)", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({
        id: "app-6",
        provisionStatus: "repo_created",
        gitRemoteUrl: "https://git.example.com/team/app-6.git",
      }),
    );
    mocks.seedDaemonApp.mockRejectedValueOnce(new Error("daemon exploded"));
    const { useAppsStore } = await import("./apps-store");
    const row = await useAppsStore.getState().create({
      teamId: "team-1",
      name: "Resilient",
      type: "fullstack_tanstack_postgres",
      visibility: "team",
    });
    expect(row.id).toBe("app-6");
    expect(useAppsStore.getState().items[0]).toMatchObject({ id: "app-6" });
  });
});
