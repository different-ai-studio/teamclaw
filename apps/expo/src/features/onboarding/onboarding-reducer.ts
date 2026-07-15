import type { OnboardingAction, OnboardingState } from "./onboarding-types";

export const initialOnboardingState: OnboardingState = {
  route: "loading",
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
        route: action.payload.team === null ? "createTeam" : "ready",
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
        isBusy: false,
        errorMessage: action.message,
        pendingEmailOTPEmail: null,
        currentTeam: null,
        currentMemberActorId: null,
        isAnonymous: false,
      };
    case "signedOut":
      return {
        ...state,
        route: "needsAuth",
        isBusy: false,
        errorMessage: null,
        pendingEmailOTPEmail: null,
        currentTeam: null,
        currentMemberActorId: null,
        isAnonymous: false,
      };
  }
}
