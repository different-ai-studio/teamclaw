// apps/ios/Packages/AMUXCore/Sources/AMUXCore/Push/CurrentSessionFocus.swift

/// Tracks which session the user is currently viewing so the push delegate
/// can suppress foreground banners for the active session.
///
/// Lives in AMUXCore (not AMUXApp) so both the app-layer delegate and the
/// AMUXUI session detail view can read/write without a dependency cycle.
public enum CurrentSessionFocus {
    nonisolated(unsafe) public static var sessionID: String?
}
