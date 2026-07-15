import Foundation
import os

let onboardingLogger = Logger(subsystem: "tech.teamclaw.mobile", category: "Onboarding")
let onboardingSignposter = OSSignposter(logger: onboardingLogger)

/// Times an async step, emitting both an os_signpost interval (visible in
/// Instruments → os_signpost / Logging) and a Logger.info line with elapsed
/// milliseconds. Used to profile cold-start onboarding latency.
@discardableResult
func measureOnboarding<T>(
    _ name: String,
    // Inherit the caller's actor isolation so `block` runs in the caller's
    // context (e.g. the @MainActor AppOnboardingCoordinator) instead of being
    // "sent" into a detached nonisolated execution — which Swift 6 rejects
    // because the closure captures non-Sendable main-actor state.
    isolation: isolated (any Actor)? = #isolation,
    _ block: () async throws -> T
) async rethrows -> T {
    let start = Date()
    let state = onboardingSignposter.beginInterval("step", "\(name)")
    do {
        let result = try await block()
        onboardingSignposter.endInterval("step", state)
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        onboardingLogger.info("\(name, privacy: .public): \(ms) ms")
        return result
    } catch {
        onboardingSignposter.endInterval("step", state)
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        onboardingLogger.error(
            "\(name, privacy: .public) failed after \(ms) ms: \(error.localizedDescription, privacy: .public)"
        )
        throw error
    }
}
