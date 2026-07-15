import Foundation

/// Publishes ACP commands on `runtime/{id}/commands` for a single
/// session's bound runtime. Extracted from `SessionDetailViewModel` so
/// the publish dance (envelope build + sender-actor stamping + topic
/// composition + protobuf encode + MQTT publish) lives in one place.
///
/// The VM still owns the user-facing concerns (caching `runtime`,
/// resolving the routing actor id, surfacing error toasts) — the
/// sender is a pure transport-side primitive: give it the runtime id,
/// actor id, and a closure that fills the `Amux_AcpCommand`, get an
/// in-flight publish back.
public struct RuntimeCommandSender: Sendable {
    public let mqtt: MQTTService
    public let teamID: String
    public let peerID: String

    public init(mqtt: MQTTService, teamID: String, peerID: String) {
        self.mqtt = mqtt
        self.teamID = teamID
        self.peerID = peerID
    }

    /// Publishes a single ACP command for the given runtime/actor pair.
    ///
    /// - Parameters:
    ///   - runtimeID: 8-char daemon runtime id (segment in the topic).
    ///     Empty throws `.runtimeIdEmpty`.
    ///   - actorID: routing actor id of the target daemon/agent (topic
    ///     prefix). Empty throws `.routeActorIdUnresolved`.
    ///   - currentHumanActorID: stamped onto `senderActorID` so the daemon
    ///     can resolve the sender's permission level via
    ///     `agent_member_access` instead of falling back to the legacy
    ///     peer-id lookup. Pass nil/empty when not yet bootstrapped
    ///     (rare; the daemon then denies as Member).
    ///   - makeCommand: closure that fills the inner `Amux_AcpCommand`.
    public func send(
        runtimeID: String,
        actorID: String,
        currentHumanActorID: String?,
        // `sending`: the closure is consumed synchronously (line below) before
        // any suspension, so ownership can transfer into this nonisolated async
        // method without a data race even though it captures non-Sendable
        // protobuf builders from a @MainActor caller.
        makeCommand: sending (inout Amux_AcpCommand) -> Void
    ) async throws {
        guard !runtimeID.isEmpty else { throw SendCommandError.runtimeIdEmpty }
        guard !actorID.isEmpty else { throw SendCommandError.routeActorIdUnresolved }

        var envelope = Amux_RuntimeCommandEnvelope()
        envelope.runtimeID = runtimeID
        envelope.actorID = actorID
        envelope.peerID = peerID
        envelope.commandID = UUID().uuidString
        envelope.timestamp = Int64(Date().timeIntervalSince1970)
        if let actorID = currentHumanActorID, !actorID.isEmpty {
            envelope.senderActorID = actorID
        }
        var acpCmd = Amux_AcpCommand()
        makeCommand(&acpCmd)
        envelope.acpCommand = acpCmd

        let data = try ProtoMQTTCoder.encode(envelope)
        try await mqtt.publish(
            topic: MQTTTopics.runtimeCommands(teamID: teamID,
                                              actorID: actorID,
                                              runtimeID: runtimeID),
            payload: data
        )
    }
}

public enum SendCommandError: LocalizedError, Sendable {
    case noRuntime
    case runtimeIdEmpty
    case routeActorIdUnresolved

    public var errorDescription: String? {
        switch self {
        case .noRuntime:
            return "Runtime not resolved yet — try again in a moment."
        case .runtimeIdEmpty:
            return "Runtime id missing — daemon hasn't published runtime state yet."
        case .routeActorIdUnresolved:
            return "Route actor id not resolved — primary agent may be offline."
        }
    }
}
