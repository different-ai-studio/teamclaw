import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  createApp: vi.fn(),
  updateAppProvisionStatus: vi.fn(),
  updateAppDeployStatus: vi.fn(),
  deployApp: vi.fn(),
  finalizeDeploy: vi.fn(),
  seedDaemonApp: vi.fn(),
  buildDaemonApp: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    apps: {
      listApps: mocks.listApps,
      createApp: mocks.createApp,
      updateAppProvisionStatus: mocks.updateAppProvisionStatus,
      updateAppDeployStatus: mocks.updateAppDeployStatus,
      deployApp: mocks.deployApp,
      finalizeDeploy: mocks.finalizeDeploy,
    },
  }),
}));

vi.mock("@/lib/daemon-local-client", () => ({
  seedDaemonApp: mocks.seedDaemonApp,
  buildDaemonApp: mocks.buildDaemonApp,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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

  it("kicks the daemon seed for a freshly created (pending) app", async () => {
    // There is no repo to wait for any more — the daemon writes its own
    // embedded template, so a pending app is immediately seedable.
    mocks.createApp.mockResolvedValueOnce(
      appRow({ id: "app-4", name: "Slides", type: "slides", provisionStatus: "pending" }),
    );
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().create({
      teamId: "team-1",
      name: "Slides",
      type: "slides",
      visibility: "team",
    });
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith("app-4", "team-1", "Slides", "slides");
  });

  it("create: seeded → PATCH ready", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "pending", teamId: "team-1" }),
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
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith("app-1", "team-1", "App", "fullstack_tanstack_postgres");
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("create: failed → PATCH error", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "pending", teamId: "team-1" }),
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

  it("create: unreachable → no status PATCH (stays pending)", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "pending", teamId: "team-1" }),
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
    expect(mocks.seedDaemonApp).toHaveBeenCalledWith("app-1", "team-1", "App", "fullstack_tanstack_postgres");
    expect(mocks.updateAppProvisionStatus.mock.calls.map((c) => c[1])).toEqual(["ready"]);
  });

  it("create: a thrown status PATCH does not reject create", async () => {
    mocks.createApp.mockResolvedValueOnce(
      appRow({ provisionStatus: "pending", teamId: "team-1" }),
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
      appRow({ id: "app-6", provisionStatus: "pending" }),
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

describe("apps-store deploy", () => {
  const readyApp = () =>
    appRow({ provisionStatus: "ready", teamId: "team-1", fcStatus: null });

  beforeEach(async () => {
    vi.clearAllMocks();
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({
      items: [readyApp()],
      loaded: true,
      loading: false,
      error: null,
      teamId: "team-1",
      deployingIds: [],
    });
  });

  it("happy path: deploy → daemon build → finalize", async () => {
    mocks.deployApp.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "awaiting_build",
      presignedPut: "https://oss/put?sig=x",
    });
    mocks.buildDaemonApp.mockResolvedValueOnce("built");
    mocks.finalizeDeploy.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "live",
      fcEndpoint: "https://x.fcapp.run",
    });
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().deploy("app-1");

    expect(mocks.buildDaemonApp).toHaveBeenCalledWith("app-1", "team-1", "https://oss/put?sig=x");
    expect(mocks.updateAppDeployStatus).not.toHaveBeenCalled();
    expect(useAppsStore.getState().items[0]).toMatchObject({
      fcStatus: "live",
      fcEndpoint: "https://x.fcapp.run",
    });
    expect(useAppsStore.getState().deployingIds).toEqual([]);
  });

  it("a daemon build that never finishes is reported as deploy_error", async () => {
    // Regression: the row used to stay at awaiting_build forever, which also
    // made the next finalize an illegal transition.
    mocks.deployApp.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "awaiting_build",
      presignedPut: "https://oss/put?sig=x",
    });
    mocks.buildDaemonApp.mockResolvedValueOnce("unreachable");
    mocks.updateAppDeployStatus.mockResolvedValueOnce({ ...readyApp(), fcStatus: "deploy_error" });
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().deploy("app-1");

    expect(mocks.finalizeDeploy).not.toHaveBeenCalled();
    expect(mocks.updateAppDeployStatus).toHaveBeenCalledWith(
      "app-1",
      "deploy_error",
      expect.stringContaining("amuxd"),
    );
    expect(useAppsStore.getState().items[0]).toMatchObject({ fcStatus: "deploy_error" });
  });

  it("a thrown finalize is reported as deploy_error and clears the in-flight flag", async () => {
    mocks.deployApp.mockResolvedValueOnce({
      ...readyApp(),
      fcStatus: "awaiting_build",
      presignedPut: "https://oss/put?sig=x",
    });
    mocks.buildDaemonApp.mockResolvedValueOnce("built");
    mocks.finalizeDeploy.mockRejectedValueOnce(new Error("fc exploded"));
    mocks.updateAppDeployStatus.mockResolvedValueOnce(null);
    const { useAppsStore } = await import("./apps-store");
    await useAppsStore.getState().deploy("app-1");

    expect(mocks.updateAppDeployStatus).toHaveBeenCalledWith("app-1", "deploy_error", "fc exploded");
    expect(useAppsStore.getState().deployingIds).toEqual([]);
  });

  it("refuses to deploy an app that is not seeded yet", async () => {
    const { useAppsStore } = await import("./apps-store");
    useAppsStore.setState({ items: [appRow({ provisionStatus: "repo_created" })] });
    await useAppsStore.getState().deploy("app-1");
    expect(mocks.deployApp).not.toHaveBeenCalled();
  });
});
