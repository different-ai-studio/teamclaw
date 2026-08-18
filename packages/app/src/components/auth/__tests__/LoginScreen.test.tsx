import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authState, backendConfig, extensionPolicy } = vi.hoisted(() => ({
  authState: {
    loading: false,
    errorMessage: null as string | null,
    otpEmail: null as string | null,
    sendOtp: vi.fn(),
    verifyOtp: vi.fn(),
    resetOtp: vi.fn(),
    signInAnonymously: vi.fn(),
  },
  backendConfig: {
    hasConfig: true,
  },
  extensionPolicy: {
    isExtension: false,
    autoCreateTeam: true,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: () => authState,
}));

vi.mock("@/lib/backend", () => ({
  hasBackendConfig: () => backendConfig.hasConfig,
}));

vi.mock("@/lib/version", () => ({
  useAppVersion: () => "0.1.0",
}));

vi.mock("@/lib/build-config", () => ({
  buildConfig: { app: { name: "TeamClu" } },
  appDisplayName: "TeamClu",
  extensionTeamOnboarding: extensionPolicy,
}));

vi.mock("@/lib/platform", () => ({
  isChromeExtension: () => extensionPolicy.isExtension,
  capabilities: { oauthSignIn: false },
}));

import { LoginScreen } from "../LoginScreen";

beforeEach(() => {
  authState.loading = false;
  authState.errorMessage = null;
  authState.otpEmail = null;
  authState.sendOtp.mockReset();
  authState.verifyOtp.mockReset();
  authState.resetOtp.mockReset();
  authState.signInAnonymously.mockReset();
  backendConfig.hasConfig = true;
  extensionPolicy.isExtension = false;
  extensionPolicy.autoCreateTeam = true;
});

describe("LoginScreen", () => {
  it("renders the email OTP form", () => {
    render(<LoginScreen />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send code/i })).toBeInTheDocument();
  });



  it("hides anonymous trial only in extension builds that disable automatic team creation", () => {
    extensionPolicy.isExtension = true;
    extensionPolicy.autoCreateTeam = false;

    render(<LoginScreen />);

    expect(screen.queryByRole("button", { name: /try anonymously/i })).not.toBeInTheDocument();
  });


  it("shows error message when signInAnonymously fails", () => {
    authState.errorMessage = "Anonymous sign in failed";
    render(<LoginScreen />);
    expect(screen.getByText(/anonymous sign in failed/i)).toBeInTheDocument();
  });
});
