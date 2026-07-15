import Foundation

// Supabase-SDK-free auth-outcome types shared by the Cloud API layer. The
// onboarding store reports sign-up outcomes without needing the Supabase SDK,
// so these live outside the (now-deleted) SupabaseAppOnboardingStore. The
// client no longer holds a Supabase URL/anon key at all — all auth and data
// calls go through the Cloud API base URL, which proxies GoTrue.

public enum SignUpOutcome: Error, LocalizedError {
    case emailAlreadyInUse
    case emailConfirmationRequired

    public var errorDescription: String? {
        switch self {
        case .emailAlreadyInUse:
            return "This email is already registered. Try signing in instead."
        case .emailConfirmationRequired:
            return "Check your inbox — we sent you a confirmation link."
        }
    }
}
