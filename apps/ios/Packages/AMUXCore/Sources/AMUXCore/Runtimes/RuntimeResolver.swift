import Foundation
import SwiftData

/// Resolves the live `Runtime` row that backs a session for the
/// session-detail view. Extracted from `SessionDetailViewModel` so the
/// resolution rule is testable in isolation and doesn't quietly mutate
/// the caller's `runtime` field as a side effect.
///
/// ## Resolution order
///
/// 1. If the caller already has a non-nil `existing` runtime, return it
///    unchanged — the view stays bound to whatever the caller picked.
/// 2. Otherwise look up the `Runtime` row keyed by `sessionId`. The actor
///    retain projects each attached session into one, so no bridge id is
///    involved — there used to be one, through `CachedAgentRuntime.runtimeId`,
///    and it was a per-spawn id that went stale the moment it was recorded.
/// 3. When no live row exists yet (just-spawned, or daemon offline), build an
///    in-memory placeholder so the composer renders. It is NOT inserted into
///    the model context — a transient view-model value.
///
/// Returns nil only when the session is missing or has no primary agent
/// (human-only sessions never spawn a runtime; building a placeholder
/// there causes downstream paths like `requestTurnHistory` and
/// `sendCommand` to surface "Runtime id missing" errors for chats where
/// there's legitimately no agent to talk to).
@MainActor
public enum RuntimeResolver {
    public static func resolve(
        existing: Runtime?,
        session: Session?,
        modelContext: ModelContext
    ) -> Runtime? {
        if let existing { return existing }
        guard let session else { return nil }

        let primaryAgentID = session.primaryAgentId?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let primaryAgentID, !primaryAgentID.isEmpty else { return nil }

        // Exactly one attachment serves a session at a time, and the retain
        // keys `Runtime` rows by session id — so the session id IS the address.
        // Rows are keyed (actor, session), so match on the session suffix
        // rather than equality — a session served from two machines has a row
        // per machine.
        let sessionID = session.sessionId
        let suffix = "::\(sessionID)"
        let matching = ((try? modelContext.fetch(FetchDescriptor<Runtime>())) ?? [])
            .filter { $0.runtimeId.hasSuffix(suffix) }
        if let resolved = matching.max(by: {
            ($0.lastEventTime ?? .distantPast) < ($1.lastEventTime ?? .distantPast)
        }) {
            return resolved
        }

        let placeholder = Runtime(runtimeId: sessionID, agentType: 0, status: 1)
        placeholder.sessionTitle = session.title
        placeholder.currentPrompt = session.summary
        // The placeholder advertises no models. The picker stays hidden until
        // the actor retain lands with the backend's real catalog — mirroring
        // the daemon, which no longer synthesizes a default model list.
        placeholder.availableModelsJSON = ""
        return placeholder
    }

    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }
}
