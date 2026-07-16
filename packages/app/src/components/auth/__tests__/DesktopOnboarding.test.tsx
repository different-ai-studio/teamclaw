import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { authState, hasConfig, saveServerConfig, reload, cloudApiUrlOverride, setCloudApiUrlOverrideMock } = vi.hoisted(() => ({
  authState: {
    loading: false,
    errorMessage: null as string | null,
    otpEmail: null as string | null,
    signInAnonymously: vi.fn(),
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
}));

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
  getEffectiveServerConfigSync: () => ({ cloudApiUrl: "https://teamclaw-api.ucar.cc" }),
  getCloudApiUrlOverride: () => cloudApiUrlOverride.value,
  getDefaultCloudApiUrl: () => "https://teamclaw-api.ucar.cc",
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
  buildConfig: { app: { name: "TeamClaw" } },
  appScheme: 'teamclaw',
}));

import { DesktopOnboarding } from "../DesktopOnboarding";

beforeEach(() => {
  authState.loading = false;
  authState.errorMessage = null;
  authState.otpEmail = null;
  authState.signInAnonymously.mockReset();
  authState.setPendingInviteToken.mockReset();
  authState.sendOtp.mockReset();
  authState.verifyOtp.mockReset();
  authState.resetOtp.mockReset();
  hasConfig.value = true;
  saveServerConfig.mockReset();
  cloudApiUrlOverride.value = null;
  setCloudApiUrlOverrideMock.mockReset();
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
    expect(screen.getByRole("button", { name: /quick trial/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in or register/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /join the team/i })).toBeInTheDocument();
    // The Cloud API URL defaults to the build config, but an explicit override is
    // reachable from here.
    expect(screen.getByRole("button", { name: /custom server/i })).toBeInTheDocument();
  });

  it("quick trial signs in anonymously", async () => {
    authState.signInAnonymously.mockResolvedValueOnce(true);
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /quick trial/i }));

    await waitFor(() => expect(authState.signInAnonymously).toHaveBeenCalled());
  });

  it("shows quick trial auth errors on the choices screen", () => {
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

  it("login path disables OTP when Supabase config is missing", () => {
    hasConfig.value = false;
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /sign in or register/i }));
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@b.com" } });

    expect(screen.getByText(/supabase is not configured/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send code/i })).toBeDisabled();
  });

  it("custom server saves an explicit cloudApiUrl override and reloads", () => {
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    fireEvent.change(screen.getByLabelText(/cloud api url/i), {
      target: { value: "https://self-hosted.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save and reload/i }));

    expect(setCloudApiUrlOverrideMock).toHaveBeenCalledWith("https://self-hosted.example.com");
    // A token from the previous backend is not valid against the new one.
    expect(reload).toHaveBeenCalled();
  });

  it("custom server surfaces an invalid URL instead of reloading", () => {
    setCloudApiUrlOverrideMock.mockImplementationOnce(() => {
      throw new Error("Not a valid http(s) URL: nope");
    });
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    fireEvent.change(screen.getByLabelText(/cloud api url/i), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: /save and reload/i }));

    expect(screen.getByText(/enter a valid http\(s\) url/i)).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
  });

  it("custom server offers a reset only when an override is active", () => {
    cloudApiUrlOverride.value = "https://self-hosted.example.com";
    render(<DesktopOnboarding />);

    fireEvent.click(screen.getByRole("button", { name: /custom server/i }));
    fireEvent.click(screen.getByRole("button", { name: /reset to the built-in default/i }));

    expect(setCloudApiUrlOverrideMock).toHaveBeenCalledWith(null);
    expect(reload).toHaveBeenCalled();
  });

  it("marks the footer URL as custom when an override is active", () => {
    cloudApiUrlOverride.value = "https://self-hosted.example.com";
    render(<DesktopOnboarding />);

    // An override must never pass as the baked build config.
    expect(screen.getByText(/custom$/)).toBeInTheDocument();
  });
});
