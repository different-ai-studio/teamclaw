import Foundation

/// Decodes recorded `MQTTIncoming` payloads (and live `MQTTIncoming`
/// from the hub) into the `TimelineInput` values the reducer consumes.
///
/// Pure function from one wire-format message → zero or one
/// `TimelineInput`. Returns nil for topics the timeline doesn't care
/// about (runtime state, device state, peer list, notify, rpc/res) so
/// callers can feed the whole captured trace and get back only the
/// session-relevant events.
///
/// `subscribeTopic` matches the production VM's filter on
/// `session/{id}/live` — that's the only topic the timeline reducer
/// listens on today; everything else is SessionListVM / TeamclawService
/// territory.
public struct TimelineInputBuilder: Sendable {
    /// Map from daemon runtime id to the owning agent's actor id, used
    /// to set `AcpInput.agentBucketKey`. Pre-resolved at the boundary
    /// so the reducer doesn't depend on `memberSheetAgents`. Empty
    /// during fixture replay tests when bucket attribution isn't being
    /// exercised.
    public let agentActorIDByRuntimeID: [String: String]

    public init(agentActorIDByRuntimeID: [String: String] = [:]) {
        self.agentActorIDByRuntimeID = agentActorIDByRuntimeID
    }

    /// Decode one `MQTTIncoming` to a timeline input. Returns nil when
    /// the topic isn't session-live or the payload doesn't decode.
    public func build(from incoming: MQTTIncoming) -> TimelineInput? {
        guard isSessionLive(topic: incoming.topic) else { return nil }
        guard let envelope = try? Teamclaw_LiveEventEnvelope(serializedBytes: incoming.payload) else {
            return nil
        }

        switch envelope.eventType {
        case "acp.event":
            return buildAcpInput(from: envelope)
        case let kind where kind.hasPrefix("message."):
            return buildLiveMessageInput(from: envelope)
        default:
            return nil
        }
    }

    /// Convenience: walk a recorded trace and return the timeline
    /// inputs in arrival order. Non-session-live and undecodable
    /// records are silently dropped (matching the production behavior
    /// of `SessionDetailViewModel`'s live stream filter).
    public func build(from records: [MQTTTraceRecord]) -> [TimelineInput] {
        records.compactMap { record -> TimelineInput? in
            guard let incoming = record.asIncoming() else { return nil }
            return build(from: incoming)
        }
    }

    // MARK: - Variant builders

    private func buildAcpInput(from envelope: Teamclaw_LiveEventEnvelope) -> TimelineInput? {
        guard let amuxEnvelope = try? Amux_Envelope(serializedBytes: envelope.body) else {
            return nil
        }
        guard case .acpEvent(let acp) = amuxEnvelope.payload else { return nil }

        let runtimeID = amuxEnvelope.runtimeID
        let bucket = agentActorIDByRuntimeID[runtimeID] ?? runtimeID
        return .acp(AcpInput(
            envelopeSequence: amuxEnvelope.sequence,
            runtimeID: runtimeID,
            agentBucketKey: bucket,
            timestamp: Date(),
            turnID: amuxEnvelope.turnID.isEmpty ? nil : amuxEnvelope.turnID,
            acpEvent: acp
        ))
    }

    private func buildLiveMessageInput(from envelope: Teamclaw_LiveEventEnvelope) -> TimelineInput? {
        guard let msgEnv = try? Teamclaw_SessionMessageEnvelope(serializedBytes: envelope.body),
              msgEnv.hasMessage else {
            return nil
        }
        let message = msgEnv.message
        // Production filter: only text-kind messages render as user_prompt.
        // Agent reply / thinking / tool result arrive separately as acp events.
        guard message.kind == .text else { return nil }

        return .liveMessage(LiveMessageInput(
            messageID: message.messageID.isEmpty ? UUID().uuidString : message.messageID,
            clientLocalID: nil,
            senderActorID: message.senderActorID,
            content: message.content,
            createdAt: message.createdAt > 0
                ? Date(timeIntervalSince1970: TimeInterval(message.createdAt))
                : Date(),
            turnID: message.turnID.isEmpty ? nil : message.turnID
        ))
    }

    // MARK: - Topic shape

    /// True iff `topic` matches `amux/{team}/session/{id}/live`. The
    /// production VM filters on exact-match with the bound session id;
    /// the builder is more permissive on purpose — it accepts any
    /// session live topic so fixtures from multiple sessions in one
    /// recorded trace can fan out.
    private func isSessionLive(topic: String) -> Bool {
        let parts = topic.split(separator: "/")
        return parts.count == 5
            && parts[0] == "amux"
            && parts[2] == "session"
            && parts[4] == "live"
    }
}
