export type OnboardingRoute =
  | "loading"
  | "needsAuth"
  | "createTeam"
  | "ready"
  | "failed";

export type TeamSummary = {
  id: string;
  name: string;
  slug: string;
  role: string;
};

export type BootstrapResult = {
  isAnonymous: boolean;
  team: TeamSummary | null;
  memberActorId: string | null;
};

export type OnboardingState = {
  route: OnboardingRoute;
  isBusy: boolean;
  errorMessage: string | null;
  pendingEmailOTPEmail: string | null;
  currentTeam: TeamSummary | null;
  currentMemberActorId: string | null;
  isAnonymous: boolean;
};

export type OnboardingAction =
  | {
      type: "beginBusy";
    }
  | {
      type: "clearError";
    }
  | {
      type: "otpRequested";
      email: string;
    }
  | {
      type: "resetPendingEmail";
    }
  | {
      type: "bootstrapResolved";
      payload: BootstrapResult;
    }
  | {
      type: "bootstrapFailed";
      message: string;
    }
  | {
      type: "signedOut";
    };
