import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  authState,
  hasConfig,
  saveServerConfig,
  reload,
  cloudApiUrlOverride,
  setCloudApiUrlOverrideMock,
  probeCloudApi,
  effectiveCloudApiUrl,
  defaultCloudApiUrl,
} = vi.hoisted(() => ({
  authState: {
    loading: false,
    errorMessage: null as string | null,
    otpEmail: null as string | null,
    setPendingInviteToken: vi.fn(),
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
    resetOtp: vi.fn(),
  },
  hasConfig: { value: true },
  saveServerConfig: vi.fn(),
  reload: vi.fn(),
  cloudApiUrlOverride: { value: null as string | null },
  setCloudApiUrlOverrideMock: vi.fn(),
  probeCloudApi: vi.fn(),
  effectiveCloudApiUrl: { value: "https://teamclu-api.ucar.cc" as string | undefined },
  defaultCloudApiUrl: { value: "https://teamclu-api.ucar.cc" as string | undefined },
}));

vi.mock("@/lib/bootstrap", () => ({ probeCloudApi }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector?: (state: typeof authState) => unknown) =>
    selector ? selector(authState) : authState,
}));

vi.mock("@/lib/server-config", () => ({
  saveServerConfig,
  getEffectiveServerConfigSync: () => ({ cloudApiUrl: effectiveCloudApiUrl.value }),
  getCloudApiUrlOverride: () => cloudApiUrlOverride.value,
  getDefaultCloudApiUrl: () => defaultCloudApiUrl.value,
  setCloudApiUrlOverride: setCloudApiUrlOverrideMock,
}));

vi.mock("@/lib/backend", () => ({
  hasBackendConfig: () => hasConfig.value,
  getBackendKind: () => "supabase",
}));

vi.mock("@/lib/version", () => ({
  useAppVersion: () => "0.1.0",
}));

vi.mock("@/lib/build-config", () => ({
  buildConfig: { app: { name: "TeamClu" } },
  appScheme: 'teamclu',
  deeplinkSchemes: ['teamclu', 'teamclaw', 'amux'],
}));

import { DesktopOnboarding } from "../DesktopOnboarding";

beforeEach(() => {
  authState.loading = false;
  authState.errorMessage = null;
  authState.otpEmail = null;
  authState.setPendingInviteToken.mockReset();
  authState.sendOtp.mockReset();
  authState.verifyOtp.mockReset();
  authState.resetOtp.mockReset();
  hasConfig.value = true;
  saveServerConfig.mockReset();
  cloudApiUrlOverride.value = null;
  effectiveCloudApiUrl.value = "https://teamclu-api.ucar.cc";
  defaultCloudApiUrl.value = "https://teamclu-api.ucar.cc";
  setCloudApiUrlOverrideMock.mockReset();
  probeCloudApi.mockReset();
  probeCloudApi.mockResolvedValue({ ok: true });
  Object.defineProperty(window, "location", {
    value: { reload },
    writable: true,
    configurable: true,
  });
  reload.mockReset();
});

describe("DesktopOnboarding", () => {
  it("shows the setup choices", () => {
    const { container } = render(<DesktopOnboarding />);

    expect(container.querySelector("[data-tauri-drag-region]")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in or register/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join the team/i })).toBeInTheDocument();
    // The Cloud API URL defaults to the build config, but an explicit override is
    // reachable from here.
    expect(screen.getByRole("button", { name: /custom server/i })).toBeInTheDocument();
  });


  it("shows auth errors on the choices screen", () => {
    authState.errorMessage = "Supabase config missing. Configure a server before signing in.";
    render(<DesktopOnboarding />);


    expect(screen.getByText(/supabase config missing/i)).toBeInTheDocument();
  });

  it("join team stashes a bare token and routes to sign-in", async () => {
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /join the team/i }));
    fireEvent.change(screen.getByLabelText(/invite link/i), { target: { value: "tok-123" } });
    fireEvent.click(screen.getByRole("button", { name: /continue to sign in/i }));

    expect(authState.setPendingInviteToken).toHaveBeenCalledWith("tok-123");
    // Member invites can't be claimed anonymously — the user is sent to sign in.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument(),
    );
  });

  it("login path reuses the email OTP form", () => {
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /sign in or register/i }));

    expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  // Both of these dead-end without a backend — sign-in cannot send a code, and
  // a claimed invite has nowhere to go — so they are closed off up front rather
  // than letting the user walk into the failure. (The login screen keeps its own
  // guard for the browser build; see LoginScreen.test.tsx.)
  it("closes off sign-in and join until a server is configured", () => {
    hasConfig.value = false;
    effectiveCloudApiUrl.value = undefined;

    render(<DesktopOnboarding />);

    expect(screen.getByRole("button", { name: /sign in or register/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /join the team/i })).toBeDisabled();
    // The one entry that can fix it stays open.
    expect(screen.getByRole("button", { name: /custom server/i })).toBeEnabled();
    expect(screen.getByText(/no server address is configured yet/i)).toBeInTheDocument();
  });

  // Rendering nothing at all is how a build with no backend baked in ended up
  // looking exactly like a working one.
  it("says so in the footer when no server is configured", () => {
    hasConfig.value = false;
    effectiveCloudApiUrl.value = undefined;

    render(<DesktopOnboarding />);

    expect(screen.getByText("no server configured")).toBeInTheDocument();
  });

  it("custom server saves an explicit cloudApiUrl override and reloads", async () => {
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    fireEvent.change(screen.getByLabelText(/cloud api url/i), {
      target: { value: "https://self-hosted.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save and reload/i }));

    await waitFor(() =>
      expect(setCloudApiUrlOverrideMock).toHaveBeenCalledWith("https://self-hosted.example.com"),
    );
    // A token from the previous backend is not valid against the new one.
    expect(reload).toHaveBeenCalled();
  });

  it("custom server surfaces an invalid URL instead of reloading", async () => {
    setCloudApiUrlOverrideMock.mockImplementationOnce(() => {
      throw new Error("Not a valid http(s) URL: nope");
    });
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    fireEvent.change(screen.getByLabelText(/cloud api url/i), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: /save and reload/i }));

    expect(await screen.findByText(/enter a valid http\(s\) url/i)).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("custom server refuses to save an address that does not answer", async () => {
    // The whole point: `https://api.example.com111` parses fine and used to save
    // fine, reloading the app into a backend that does not exist.
    probeCloudApi.mockResolvedValue({ ok: false, reason: "unreachable" });
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    fireEvent.change(screen.getByLabelText(/cloud api url/i), {
      target: { value: "https://api.example.com111" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save and reload/i }));

    expect(await screen.findByText(/could not reach that address/i)).toBeInTheDocument();
    expect(setCloudApiUrlOverrideMock).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("custom server distinguishes 'answered but not a Cloud API' from 'unreachable'", async () => {
    probeCloudApi.mockResolvedValue({ ok: false, reason: "not-cloud-api", status: 404 });
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    fireEvent.change(screen.getByLabelText(/cloud api url/i), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save and reload/i }));

    expect(await screen.findByText(/not a teamclu cloud api/i)).toBeInTheDocument();
    expect(setCloudApiUrlOverrideMock).not.toHaveBeenCalled();
  });

  it("custom server lets the user override a failed probe", async () => {
    // Configuring a server that is not up yet, or one only reachable from a
    // network the user is not on right now, is legitimate — the probe is a
    // guard, not a verdict.
    probeCloudApi.mockResolvedValue({ ok: false, reason: "unreachable" });
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    fireEvent.change(screen.getByLabelText(/cloud api url/i), {
      target: { value: "https://not-up-yet.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save and reload/i }));

    fireEvent.click(await screen.findByRole("button", { name: /save it anyway/i }));

    expect(setCloudApiUrlOverrideMock).toHaveBeenCalledWith("https://not-up-yet.example.com");
    expect(reload).toHaveBeenCalled();
  });

  it("custom server hides the override once the address is edited again", async () => {
    probeCloudApi.mockResolvedValue({ ok: false, reason: "unreachable" });
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    const input = screen.getByLabelText(/cloud api url/i);
    fireEvent.change(input, { target: { value: "https://typo.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /save and reload/i }));
    expect(await screen.findByRole("button", { name: /save it anyway/i })).toBeInTheDocument();

    // A different address has not been rejected yet.
    fireEvent.change(input, { target: { value: "https://other.example.com" } });
    expect(screen.queryByRole("button", { name: /save it anyway/i })).toBeNull();
  });

  it("custom server offers a reset only when an override is active", () => {
    cloudApiUrlOverride.value = "https://self-hosted.example.com";
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    fireEvent.click(screen.getByRole("button", { name: /reset to the built-in default/i }));

    // Reset goes back to the baked default, so there is nothing to probe.
    expect(setCloudApiUrlOverrideMock).toHaveBeenCalledWith(null);
    expect(probeCloudApi).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  it("hides the reset when the build has no default to return to", () => {
    cloudApiUrlOverride.value = "https://self-hosted.example.com";
    defaultCloudApiUrl.value = undefined;
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));

    // Resetting there would clear the only address the app has.
    expect(screen.queryByRole("button", { name: /reset to the built-in default/i })).toBeNull();
  });

  it("marks the footer URL as custom when an override is active", () => {
    cloudApiUrlOverride.value = "https://self-hosted.example.com";
    render(<DesktopOnboarding />);

    // An override must never pass as the baked build config. Anchored on the
    // host: the entry row carries the same "custom" tag now, so a bare /custom$/
    // matches in two places.
    expect(screen.getByText(/ucar\.cc · custom$/)).toBeInTheDocument();
  });

  // The footer is 10px type at the bottom of the window, and it says nothing
  // about which of the three entries put the app on that server.
  it("marks the custom server entry itself when an override is active", () => {
    cloudApiUrlOverride.value = "https://self-hosted.example.com";
    render(<DesktopOnboarding />);

    const row = screen.getByRole("button", { name: /custom server/i });
    expect(row).toHaveTextContent("self-hosted.example.com");
  });
});
