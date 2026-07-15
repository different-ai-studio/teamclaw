import Foundation
import Aptabase

/// Thin wrapper over the Aptabase SDK so call sites stay decoupled from the
/// vendor API and we have a single place to gate/redact events later. Mirrors
/// the desktop `trackEvent` helper (Rust `telemetry_track`) and shares the same
/// Aptabase app key `A-US-9094113207`.
enum Analytics {
    /// App key for the shared TeamClaw Aptabase project (matches desktop).
    static let appKey = "A-US-9094113207"

    /// Initialise the SDK once at launch. Safe to call from `AMUXApp.init()`.
    static func start() {
        Aptabase.shared.initialize(appKey: appKey)
    }

    /// Fire-and-forget product event. Props must be JSON-serialisable scalars.
    static func track(_ event: String, _ props: [String: Any] = [:]) {
        if props.isEmpty {
            Aptabase.shared.trackEvent(event)
        } else {
            Aptabase.shared.trackEvent(event, with: props)
        }
    }
}
