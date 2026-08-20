import Foundation

/// Failure modes when dispatching an ACP command to a session's agent.
///
/// Commands ride `RpcRequest.runtime_command` addressed by `(actor, session)`
/// (ADR-0003) — the daemon answers every dispatch, so failures here are
/// surfaced answers, never silent drops.
public enum SendCommandError: LocalizedError, Sendable, Equatable {
    case noAgent
    case addressEmpty
    case routeActorIdUnresolved
    case rpcUnavailable
    case sessionCold
    case rejected(String)

    public var errorDescription: String? {
        switch self {
        case .noAgent:
            return "Runtime not resolved yet — try again in a moment."
        case .addressEmpty:
            return "Runtime id missing — daemon hasn't published runtime state yet."
        case .routeActorIdUnresolved:
            return "Route actor id not resolved — primary agent may be offline."
        case .rpcUnavailable:
            return "Messaging channel not ready — try again in a moment."
        case .sessionCold:
            return "Agent isn't attached to this session right now — it may have gone idle."
        case .rejected(let reason):
            return reason.isEmpty ? "Command rejected by the agent's daemon." : reason
        }
    }
}
