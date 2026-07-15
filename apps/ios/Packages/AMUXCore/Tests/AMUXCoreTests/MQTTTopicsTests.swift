import XCTest
@testable import AMUXCore

final class MQTTTopicsTests: XCTestCase {
    func testTeamclawRearchitectureTopics() {
        XCTAssertEqual(
            MQTTTopics.actorRpcRequest(teamID: "team1", actorID: "actor-a"),
            "amux/team1/actor-a/rpc/req"
        )
        XCTAssertEqual(
            MQTTTopics.actorRpcResponse(teamID: "team1", actorID: "actor-a"),
            "amux/team1/actor-a/rpc/res"
        )
        XCTAssertEqual(
            MQTTTopics.actorNotify(teamID: "team1", actorID: "actor-a"),
            "amux/team1/actor-a/notify"
        )
        XCTAssertEqual(
            MQTTTopics.actorState(teamID: "team1", actorID: "actor-a"),
            "amux/team1/actor-a/state"
        )
        XCTAssertEqual(
            MQTTTopics.runtimeState(teamID: "team1", actorID: "actor-a", runtimeID: "rt-1"),
            "amux/team1/actor-a/runtime/rt-1/state"
        )
        XCTAssertEqual(
            MQTTTopics.runtimeCommands(teamID: "team1", actorID: "actor-a", runtimeID: "rt-1"),
            "amux/team1/actor-a/runtime/rt-1/commands"
        )
        XCTAssertEqual(
            MQTTTopics.sessionLive(teamID: "team1", sessionID: "sess-1"),
            "amux/team1/session/sess-1/live"
        )
    }
}
