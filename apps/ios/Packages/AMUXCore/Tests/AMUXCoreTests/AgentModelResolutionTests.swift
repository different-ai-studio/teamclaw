import XCTest
@testable import AMUXCore

final class AgentModelResolutionTests: XCTestCase {
    func testParticipantOutranksEverything() {
        // The inversion this ordering exists to prevent: the attachment used to
        // win, so a client-side memory folded into it could shadow the cloud's
        // authoritative value for the session.
        let r = AgentModelResolution.resolve(
            participantModel: "cloud/authoritative",
            liveModel: "live/model",
            mruCandidate: "mru/model"
        )
        XCTAssertEqual(r.modelID, "cloud/authoritative")
        XCTAssertEqual(r.source, .participant)
        XCTAssertFalse(r.requiresExplicitPick)
    }

    func testLiveWinsWhenParticipantIsSilent() {
        let r = AgentModelResolution.resolve(
            participantModel: nil,
            liveModel: "live/model",
            mruCandidate: "mru/model"
        )
        XCTAssertEqual(r.modelID, "live/model")
        XCTAssertEqual(r.source, .live)
    }

    func testMRUIsTheLastResortBeforeAsking() {
        let r = AgentModelResolution.resolve(
            participantModel: nil,
            liveModel: nil,
            mruCandidate: "mru/model"
        )
        XCTAssertEqual(r.modelID, "mru/model")
        XCTAssertEqual(r.source, .clientMRU)
        // A past explicit choice needs no re-confirmation.
        XCTAssertFalse(r.requiresExplicitPick)
    }

    func testNothingChosenDemandsAPick() {
        // Previously this case let the daemon pick on spawn — the implicit
        // resolution ADR-0007 removes.
        let r = AgentModelResolution.resolve(
            participantModel: nil,
            liveModel: nil,
            mruCandidate: nil
        )
        XCTAssertNil(r.modelID)
        XCTAssertEqual(r.source, .unpicked)
        XCTAssertTrue(r.requiresExplicitPick)
    }

    func testBlankStringsCountAsAbsent() {
        // Empty and whitespace-only values arrive from proto defaults and from
        // trimmed user input; treating them as answers pins a nameless model.
        let r = AgentModelResolution.resolve(
            participantModel: "",
            liveModel: "   ",
            mruCandidate: "\n"
        )
        XCTAssertEqual(r.source, .unpicked)
    }

    func testTrimsTheAnswerItReturns() {
        let r = AgentModelResolution.resolve(
            participantModel: "  spaced/model  ",
            liveModel: nil,
            mruCandidate: nil
        )
        XCTAssertEqual(r.modelID, "spaced/model")
    }
}
