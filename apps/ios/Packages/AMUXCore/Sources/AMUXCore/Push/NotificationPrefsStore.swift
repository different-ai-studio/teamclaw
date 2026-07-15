import Foundation
import Observation

/// Observable façade over `NotificationsRepository` — user-level notification
/// preferences plus the per-session mute set.
///
/// Built once per team runtime by `AppOnboardingCoordinator.prepareTeamRuntime`
/// (prefs are user-scoped, so rebuilding on team switch just re-fetches the
/// same row). Writes are optimistic: local state flips immediately and rolls
/// back with `errorMessage` set when the Cloud API call fails.
@Observable
@MainActor
public final class NotificationPrefsStore {
    public private(set) var prefs = NotificationPrefsRecord()
    public private(set) var mutedSessionIDs: Set<String> = []
    public private(set) var isLoading = false
    public var errorMessage: String?

    private let repository: any NotificationsRepository

    public init(repository: any NotificationsRepository) {
        self.repository = repository
    }

    public func isMuted(_ sessionID: String) -> Bool {
        mutedSessionIDs.contains(sessionID)
    }

    public func reload() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        do {
            async let prefsTask = repository.getPrefs()
            async let mutedTask = repository.listMutedSessionIDs()
            let (remotePrefs, remoteMuted) = try await (prefsTask, mutedTask)
            // No row yet → defaults (enabled, no quiet hours).
            prefs = remotePrefs ?? NotificationPrefsRecord()
            mutedSessionIDs = remoteMuted
            errorMessage = nil
        } catch is CancellationError {
            // SwiftUI .task cancelled (e.g. sheet dismissed mid-load) —
            // keep the last good state silent.
        } catch let urlError as URLError where urlError.code == .cancelled {
            // Same story for URLSession-level cancellation.
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func setEnabled(_ enabled: Bool) async {
        var next = prefs
        next.enabled = enabled
        await put(next)
    }

    /// Set (or clear, with both nil) the quiet-hours window. Writes always
    /// carry the device's current time zone so the server evaluates the
    /// minute-of-day window in the zone the user picked it in.
    public func setQuietHours(startMin: Int?, endMin: Int?) async {
        var next = prefs
        next.dndStartMin = startMin
        next.dndEndMin = endMin
        next.dndTZ = TimeZone.current.identifier
        await put(next)
    }

    public func toggleMute(sessionID: String) async {
        guard !sessionID.isEmpty else { return }
        let wasMuted = mutedSessionIDs.contains(sessionID)
        // Optimistic flip; rolled back below on failure.
        if wasMuted {
            mutedSessionIDs.remove(sessionID)
        } else {
            mutedSessionIDs.insert(sessionID)
        }
        do {
            if wasMuted {
                try await repository.unmute(sessionID: sessionID)
            } else {
                try await repository.mute(sessionID: sessionID, until: nil)
            }
            errorMessage = nil
        } catch {
            if wasMuted {
                mutedSessionIDs.insert(sessionID)
            } else {
                mutedSessionIDs.remove(sessionID)
            }
            errorMessage = error.localizedDescription
        }
    }

    /// Optimistic prefs write — show the new value immediately, then settle
    /// on the server-normalized row (or roll back on failure).
    private func put(_ next: NotificationPrefsRecord) async {
        let previous = prefs
        prefs = next
        do {
            prefs = try await repository.putPrefs(next)
            errorMessage = nil
        } catch {
            prefs = previous
            errorMessage = error.localizedDescription
        }
    }
}
