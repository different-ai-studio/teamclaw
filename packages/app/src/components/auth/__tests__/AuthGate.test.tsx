import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { setLocalCacheTeamGateMock } = vi.hoisted(() => ({
  setLocalCacheTeamGateMock: vi.fn().mockResolvedValue(undefined),
}));

const { authState, currentTeamMock, backendMock } = vi.hoisted(() => ({
  authState: {
    session: { user: { id: "user-1" } } as { user: { id: string; is_anonymous?: boolean } } | null,
    loading: false,
    authFlow: "idle" as "idle" | "invite",
    hydrate: vi.fn(),
    pendingInviteToken: null as string | null,
    claimPendingInvite: vi.fn(),
    // Contact-matched invites (PendingInvitesDialog). Empty by default so the
    // dialog stays closed and these tests only exercise the gate itself.
    pendingInvites: [] as unknown[],
    refreshPendingInvites: vi.fn(),
  },
  currentTeamMock: {
    reloadAndSwitchTo: vi.fn(),
    setActiveTeam: vi.fn(),
    switchToTeam: vi.fn(),
    team: null as null | { id: string },
    teamUserId: null as null | string,
  },
  backendMock: {
    teams: {
      listCurrentUserTeams: vi.fn(),
      listAllMyTeams: vi.fn(),
      createTeam: vi.fn(),
    },
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@/stores/auth-store", () => {
  const useAuthStore = (selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState;
  useAuthStore.getState = () => authState;
  return { useAuthStore };
});

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => currentTeamMock,
  },
  setLocalCacheTeamGate: setLocalCacheTeamGateMock,
  readCachedCurrentTeam: () => null,
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => backendMock,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
  isTauri: () => true,
  removeStartupSkeleton: () => {},
}));

vi.mock("@/lib/random-team-name", () => ({
  generateRandomTeamName: () => "Trial Team",
}));

vi.mock("@/stores/setup", () => ({
  useSetupStore: (selector: (s: { loaded: boolean; requiredSatisfied: () => boolean; listRequirements: () => void }) => unknown) =>
    selector({ loaded: true, requiredSatisfied: () => true, listRequirements: () => {} }),
  setupPreviouslySatisfied: () => false,
}));

vi.mock("../SetupWizard", () => ({
  SetupWizard: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>Setup wizard</button>
  ),
}));

vi.mock("@/stores/daemon-onboarding", () => ({
  useDaemonOnboardingStore: (selector: (s: { status: string; loaded: boolean; refresh: () => Promise<void> }) => unknown) =>
    selector({ status: 'ready', loaded: true, refresh: async () => {} }),
}));

vi.mock("../DaemonOnboardingWizard", () => ({
  DaemonOnboardingWizard: ({ onDone }: { onDone: () => void }) => (
    <button onClick={onDone}>Daemon onboarding wizard</button>
  ),
}));

vi.mock("../DesktopOnboarding", () => ({
  DesktopOnboarding: () => <div>Desktop onboarding</div>,
}));

vi.mock("../LoginScreen", () => ({
  LoginScreen: () => <div>Login screen</div>,
}));

import { AuthGate } from "../AuthGate";

beforeEach(() => {
  authState.session = { user: { id: "user-1" } };
  authState.loading = false;
  authState.authFlow = "idle";
  authState.hydrate.mockReset();
  backendMock.teams.listCurrentUserTeams.mockReset();
  backendMock.teams.listAllMyTeams.mockReset();
  backendMock.teams.createTeam.mockReset();
  currentTeamMock.reloadAndSwitchTo.mockReset();
  currentTeamMock.setActiveTeam.mockReset();
  currentTeamMock.switchToTeam.mockReset();
  currentTeamMock.team = null;
  currentTeamMock.teamUserId = null;
  backendMock.teams.listAllMyTeams.mockResolvedValue([]);
  setLocalCacheTeamGateMock.mockClear();
});

describe("AuthGate", () => {
  it("keeps the shell blocked while an authenticated onboarding operation is loading", async () => {
    authState.loading = true;

    const { container } = render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    // Loading gates now render nothing (the static #skeleton shows through #root
    // in the real app) instead of a Lobster spinner — the shell stays blocked.
    await waitFor(() => expect(screen.queryByText("App shell")).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps desktop onboarding mounted while an unauthenticated action is loading", async () => {
    authState.session = null;
    authState.loading = false;

    const view = render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText("Desktop onboarding")).toBeInTheDocument());

    authState.loading = true;
    view.rerender(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    expect(screen.getByText("Desktop onboarding")).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
  });

  it("keeps desktop onboarding mounted while an invite claim has an anonymous session", async () => {
    authState.session = { user: { id: "anon-invite" } };
    authState.loading = true;
    authState.authFlow = "invite";

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText("Desktop onboarding")).toBeInTheDocument());
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    expect(screen.queryByText("App shell")).not.toBeInTheDocument();
  });

  it("renders the shell optimistically from a cached team for the same user, without a network probe", async () => {
    // current-team was hydrated from the persisted cache for THIS user.
    currentTeamMock.team = { id: "team-cached" };
    currentTeamMock.teamUserId = "user-1";
    // Make the list probe hang — first paint must not wait on it.
    backendMock.teams.listCurrentUserTeams.mockReturnValue(new Promise(() => {}));

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
    // The optimistic gate must not block on (or even fire) the bootstrap probe;
    // App's mount-time load() revalidates in the background instead.
    expect(backendMock.teams.listCurrentUserTeams).not.toHaveBeenCalled();
    // …but it must prime the local-cache team gate so the backend accepts the
    // team-scoped session-cache reads App fires on mount (no blank-list flash).
    expect(setLocalCacheTeamGateMock).toHaveBeenCalledWith("team-cached");
  });

  it("does not adopt a cached team that belongs to a different user", async () => {
    // A previous user's team is still in the store (persisted cache), but the
    // session is a different user — must re-resolve, not reuse the foreign team.
    currentTeamMock.team = { id: "team-foreign" };
    currentTeamMock.teamUserId = "other-user";
    backendMock.teams.listCurrentUserTeams.mockResolvedValueOnce([
      { id: "team-mine", name: "Mine", slug: "mine" },
    ]);
    currentTeamMock.setActiveTeam.mockResolvedValueOnce(undefined);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() => expect(backendMock.teams.listCurrentUserTeams).toHaveBeenCalled());
    await waitFor(() =>
      expect(currentTeamMock.setActiveTeam).toHaveBeenCalledWith({
        id: "team-mine",
        name: "Mine",
        slug: "mine",
      }),
    );
  });

  it("switches to an existing team using the listed row, without a redundant getTeam fetch", async () => {
    backendMock.teams.listCurrentUserTeams.mockResolvedValueOnce([
      { id: "team-existing", name: "Acme", slug: "acme" },
    ]);
    currentTeamMock.setActiveTeam.mockResolvedValueOnce(undefined);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() =>
      expect(currentTeamMock.setActiveTeam).toHaveBeenCalledWith({
        id: "team-existing",
        name: "Acme",
        slug: "acme",
      }),
    );
    // The list row already carries {id,name,slug}; bootstrap must not re-fetch
    // the same team via reloadAndSwitchTo (which does an extra GET /v1/teams/:id).
    expect(currentTeamMock.reloadAndSwitchTo).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
  });

  it("creates a first team and switches to it before rendering the shell", async () => {
    backendMock.teams.listCurrentUserTeams.mockResolvedValueOnce([]);
    backendMock.teams.listAllMyTeams.mockResolvedValueOnce([]);
    backendMock.teams.createTeam.mockResolvedValueOnce({
      id: "team-new",
      name: "Trial Team",
      slug: "trial-team",
    });
    currentTeamMock.setActiveTeam.mockResolvedValueOnce(undefined);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() =>
      expect(currentTeamMock.setActiveTeam).toHaveBeenCalledWith({
        id: "team-new",
        name: "Trial Team",
        slug: "trial-team",
      }),
    );
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
  });

  it("switches to a cross-org team when current-org listing is empty", async () => {
    backendMock.teams.listCurrentUserTeams.mockResolvedValueOnce([]);
    backendMock.teams.listAllMyTeams.mockResolvedValueOnce([
      { id: "team-other-org", name: "Other Org Team", slug: "other", orgId: "org-b", orgName: "Org B" },
    ]);
    currentTeamMock.switchToTeam.mockResolvedValueOnce(undefined);

    render(
      <AuthGate>
        <div>App shell</div>
      </AuthGate>,
    );

    await waitFor(() =>
      expect(currentTeamMock.switchToTeam).toHaveBeenCalledWith("team-other-org"),
    );
    expect(backendMock.teams.createTeam).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("App shell")).toBeInTheDocument());
  });
});
