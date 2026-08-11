import type { OnboardingAction, OnboardingState } from "./onboarding-types";

export const initialOnboardingState: OnboardingState = {
  route: "loading",
  teamChoices: [],
  isBusy: false,
  errorMessage: null,
  pendingEmailOTPEmail: null,
  currentTeam: null,
  currentMemberActorId: null,
  isAnonymous: false,
};

export function onboardingReducer(
  state: OnboardingState,
  action: OnboardingAction,
): OnboardingState {
  switch (action.type) {
    case "beginBusy":
      return {
        ...state,
        isBusy: true,
        errorMessage: null,
      };
    case "clearError":
      return {
        ...state,
        errorMessage: null,
      };
    case "otpRequested":
      return {
        ...state,
        pendingEmailOTPEmail: action.email,
        isBusy: false,
      };
    case "resetPendingEmail":
      return {
        ...state,
        pendingEmailOTPEmail: null,
        errorMessage: null,
      };
    case "bootstrapResolved":
      return {
        ...state,
        // Three outcomes, not two. A null team with choices means the bootstrap
        // stopped to ask rather than finding nothing.
        route:
          action.payload.team !== null
            ? "ready"
            : action.payload.teamChoices.length > 0
              ? "selectTeam"
              : "createTeam",
        teamChoices: action.payload.teamChoices,
        isBusy: false,
        errorMessage: null,
        pendingEmailOTPEmail: null,
        currentTeam: action.payload.team,
        currentMemberActorId: action.payload.memberActorId,
        isAnonymous: action.payload.isAnonymous,
      };
    case "bootstrapFailed":
      return {
        ...state,
        route: "failed",
        teamChoices: [],
        isBusy: false,
        errorMessage: action.message,
        pendingEmailOTPEmail: null,
        currentTeam: null,
        currentMemberActorId: null,
        isAnonymous: false,
      };
    case "teamSelectionFailed":
      return {
        ...state,
        route: "selectTeam",
        isBusy: false,
        errorMessage: action.message,
      };
    case "signedOut":
      return {
        ...state,
        route: "needsAuth",
        teamChoices: [],
        isBusy: false,
        errorMessage: null,
        pendingEmailOTPEmail: null,
        currentTeam: null,
        currentMemberActorId: null,
        isAnonymous: false,
      };
  }
}
