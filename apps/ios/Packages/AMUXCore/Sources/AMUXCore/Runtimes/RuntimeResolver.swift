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
/// 2. Otherwise, walk Session → primaryAgentId → CachedAgentRuntime
///    (most recently updated row matching `sessionId`) → Runtime
///    (matched on the 8-char `runtimeId` bridge from CachedAgentRuntime).
/// 3. When the live Runtime row hasn't been published yet (just-spawned,
///    daemon offline, cached row predates the runtime_id column), build
///    an in-memory placeholder seeded from `cached.backendType` so the
///    composer's model picker renders before MQTT or Supabase catches
///    up. The placeholder is NOT inserted into the model context — it's
///    a transient view-model value.
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

        let sessionID = session.sessionId
        let cachedDescriptor = FetchDescriptor<CachedAgentRuntime>(
            predicate: #Predicate { $0.sessionId == sessionID }
        )
        let cachedRows = (try? modelContext.fetch(cachedDescriptor)) ?? []
        let cached = cachedRows.max(by: { $0.updatedAt < $1.updatedAt })

        // Prefer the 8-char runtime_id (correct topic segment for
        // runtime/{id}/commands). Fall back to backend_session_id only as
        // a last-resort identity for the placeholder when a brand-new
        // session hasn't been re-fetched from Supabase yet — commands
        // sent on this id won't route, but the UI renders.
        let bridge = nonEmpty(cached?.runtimeId) ?? nonEmpty(cached?.backendSessionId) ?? ""

        if !bridge.isEmpty {
            let runtimeDescriptor = FetchDescriptor<Runtime>(
                predicate: #Predicate { $0.runtimeId == bridge }
            )
            if let resolved = (try? modelContext.fetch(runtimeDescriptor))?.first {
                return resolved
            }
        }

        let placeholder = Runtime(
            runtimeId: bridge,
            agentType: agentTypeRaw(for: cached?.backendType),
            status: 1
        )
        placeholder.sessionTitle = session.title
        placeholder.currentPrompt = session.summary
        placeholder.availableModelsJSON = encodedDefaultModels(for: cached?.backendType)
        if let m = cached?.currentModel, !m.isEmpty { placeholder.currentModel = m }
        return placeholder
    }

    static func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    /// Maps `CachedAgentRuntime.backendType` strings to the
    /// `Amux_AgentType` raw values stored on the placeholder Runtime.
    /// Kept aligned with `daemon/src/runtime/models.rs` ordering.
    static func agentTypeRaw(for backendType: String?) -> Int {
        switch backendType {
        case "claude": return 1
        case "opencode": return 2
        case "codex": return 3
        default: return 1
        }
    }

    /// Mirrors the daemon's hardcoded `available_models_for(agent_type)`
    /// so the placeholder Runtime has a populated picker before the live
    /// MQTT-published Runtime row arrives. Keep these lists in sync with
    /// `daemon/src/runtime/models.rs`.
    static func encodedDefaultModels(for backendType: String?) -> String {
        let models: [AvailableModel]
        switch backendType {
        case "claude":
            models = [
                AvailableModel(id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5"),
                AvailableModel(id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6"),
                AvailableModel(id: "claude-opus-4-7", displayName: "Claude Opus 4.7"),
            ]
        default:
            models = []
        }
        guard !models.isEmpty,
              let data = try? JSONEncoder().encode(models),
              let json = String(data: data, encoding: .utf8) else {
            return ""
        }
        return json
    }
}
