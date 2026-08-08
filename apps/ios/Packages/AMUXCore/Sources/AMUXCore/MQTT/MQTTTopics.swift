import Foundation

public enum MQTTTopics {
    public static func normalizedTeamID(_ teamID: String) -> String {
        teamID.isEmpty ? "teamclaw" : teamID
    }

    public static func actorBase(teamID: String, actorID: String) -> String {
        "amux/\(normalizedTeamID(teamID))/\(actorID)"
    }

    public static func teamclawBase(teamID: String) -> String {
        "amux/\(normalizedTeamID(teamID))"
    }

    /// Fixed actor-scoped request channel for the MQTT rearchitecture.
    public static func actorRpcRequest(teamID: String, actorID: String) -> String {
        "\(actorBase(teamID: teamID, actorID: actorID))/rpc/req"
    }

    /// Fixed actor-scoped response channel for the MQTT rearchitecture.
    public static func actorRpcResponse(teamID: String, actorID: String) -> String {
        "\(actorBase(teamID: teamID, actorID: actorID))/rpc/res"
    }

    /// Targeted actor notification channel used to invalidate local state.
    public static func actorNotify(teamID: String, actorID: String) -> String {
        "\(actorBase(teamID: teamID, actorID: actorID))/notify"
    }

    /// Single realtime stream for live session events in the new contract.
    public static func sessionLive(teamID: String, sessionID: String) -> String {
        "\(teamclawBase(teamID: teamID))/session/\(sessionID)/live"
    }

    // ─── Phase 2 — new-architecture paths (dual-published by daemon since Phase 1a) ───

    /// New actor-scoped retained state topic. LWT migrates here in Phase 3;
    /// until then Phase 1a daemon mirror-publishes normal transitions here and
    /// keeps LWT firing on /status. ConnectionMonitor dual-subscribes.
    public static func actorState(teamID: String, actorID: String) -> String {
        "\(actorBase(teamID: teamID, actorID: actorID))/state"
    }

    public static func runtimeCommands(teamID: String, actorID: String, runtimeID: String) -> String {
        "\(actorBase(teamID: teamID, actorID: actorID))/runtime/\(runtimeID)/commands"
    }

    /// Team-scoped user notify channel. Requires broker JWT auth before use
    /// (Phase 1d prerequisite); builder is available now so Phase 2 code can
    /// reference it, but no subscribe happens until 1d ships.
    public static func userNotify(teamID: String, actorID: String) -> String {
        "\(teamclawBase(teamID: teamID))/user/\(actorID)/notify"
    }
}
