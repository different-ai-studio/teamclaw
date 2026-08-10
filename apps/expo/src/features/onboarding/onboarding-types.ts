import type { BootstrapTeam } from "./bootstrap-route";

export type OnboardingRoute =
  | "loading"
  | "needsAuth"
  | "createTeam"
  /**
   * The user is on more than one team and has not chosen. iOS routes here too
   * (`AppOnboardingCoordinator.route == .selectTeam`) rather than adopting one
   * silently — the team decides which org the session is active in, and the
   * wrong one is filtered to empty by RLS.
   */
  | "selectTeam"
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
  /** The adopted team, or null when there is nothing to adopt yet. */
  team: TeamSummary | null;
  memberActorId: string | null;
  /**
   * Teams to choose between. Non-empty only when the bootstrap stopped to ask;
   * `team` is null in that case.
   */
  teamChoices: BootstrapTeam[];
};

export type OnboardingState = {
  route: OnboardingRoute;
  /** Populated while `route === "selectTeam"`, empty otherwise. */
  teamChoices: BootstrapTeam[];
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
      /** Activation failed — stay on the picker so another team can be tried. */
      type: "teamSelectionFailed";
      message: string;
    }
  | {
      type: "signedOut";
    };
