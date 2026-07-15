import Foundation

/// Dependency-free analytics seam. AMUXCore stays free of vendor SDKs (see the
/// Package.swift charter), so the app target injects a real sink — backed by
/// Aptabase — at launch via `AnalyticsSink.handler`. Until then, calls are a
/// silent no-op, which keeps unit tests and SwiftUI previews quiet.
public enum AnalyticsSink {
    /// Injected once at app launch on the main thread. `nonisolated(unsafe)` is
    /// sound here: the handler is written exactly once before any event fires,
    /// then only read afterwards.
    nonisolated(unsafe) public static var handler: (@Sendable (String, [String: String]) -> Void)?

    /// Fire-and-forget product event. Props are string-valued to stay `Sendable`
    /// across the `AMUXCore` → app-target boundary under Swift 6.
    public static func track(_ event: String, _ props: [String: String] = [:]) {
        handler?(event, props)
    }
}
