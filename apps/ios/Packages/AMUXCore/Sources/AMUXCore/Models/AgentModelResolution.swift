import Foundation

/// Which model an agent runs on in a session, and whether anybody actually
/// chose it.
///
/// iOS's counterpart to the desktop's `selectAgentModel`. Kept as a pure
/// function so the ordering is testable without a ModelContext, a live MQTT
/// retain, or a sheet loader — the ordering is the part that has a wrong answer
/// available, and it had one: the attachment used to outrank the participant
/// row, so a client-side memory could shadow the cloud's authoritative value.
public enum AgentModelResolution {
    public enum Source: Equatable {
        /// `session_participants.model` — the authority (ADR-0005), written by
        /// the daemon, the only component that sees what the runtime settled on.
        case participant
        /// The live attachment's `current_model` from the retain: a fact about
        /// what is bound right now, but a *derived* one.
        case live
        /// This install's MRU. A past explicit choice, so good enough to start a
        /// new chat on — but never a statement about this session.
        case clientMRU
        /// Nothing chose anything. The caller must ask before running: letting
        /// the daemon pick is exactly the implicit resolution ADR-0007 removes.
        case unpicked
    }

    public struct Resolved: Equatable {
        public let modelID: String?
        public let source: Source

        public init(modelID: String?, source: Source) {
            self.modelID = modelID
            self.source = source
        }

        /// Does a human still need to confirm this before anything runs?
        public var requiresExplicitPick: Bool { source == .unpicked }
    }

    /// Resolve in authority order.
    ///
    /// `participantModel` first because it is the fact itself; `liveModel`
    /// second because it is the same fact observed from the runtime; the MRU
    /// last because it describes this install's habits, not this session.
    ///
    /// `mruCandidate` is expected to have already been checked against the live
    /// catalog by the caller (`ClientModelMRU.firstAvailable`) — a remembered
    /// model the catalog no longer offers is not a candidate at all.
    public static func resolve(
        participantModel: String?,
        liveModel: String?,
        mruCandidate: String?
    ) -> Resolved {
        if let model = participantModel?.nonBlank {
            return Resolved(modelID: model, source: .participant)
        }
        if let model = liveModel?.nonBlank {
            return Resolved(modelID: model, source: .live)
        }
        if let model = mruCandidate?.nonBlank {
            return Resolved(modelID: model, source: .clientMRU)
        }
        return Resolved(modelID: nil, source: .unpicked)
    }
}

private extension String {
    /// The string with whitespace trimmed, or nil when nothing is left.
    var nonBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
