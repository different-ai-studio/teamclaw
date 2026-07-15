import Foundation
import Testing
@testable import AMUXCore

@Suite("parseInboxEnvelope")
struct InboxHandlerTests {
    private func payload(_ json: String) -> Data { Data(json.utf8) }

    @Test("parses a well-formed inbox ping for this user")
    func parsesValid() {
        let result = parseInboxEnvelope(
            topic: "inbox/user-abc",
            payload: payload(#"{"session_id":"sess-1","ts":1700000000}"#),
            expectedUserID: "user-abc"
        )
        #expect(result == .success(InboxPing(sessionID: "sess-1", type: nil, ts: 1700000000)))
    }

    @Test("accepts payload without optional ts")
    func acceptsMissingTs() {
        let result = parseInboxEnvelope(
            topic: "inbox/user-abc",
            payload: payload(#"{"session_id":"sess-1"}"#),
            expectedUserID: "user-abc"
        )
        #expect(result == .success(InboxPing(sessionID: "sess-1", type: nil, ts: nil)))
    }

    @Test("rejects topic that is not inbox/")
    func rejectsNonInboxTopic() {
        let result = parseInboxEnvelope(
            topic: "amux/team1/session/s1/live",
            payload: payload(#"{"session_id":"s1"}"#),
            expectedUserID: "user-abc"
        )
        #expect(result == .failure(.notInboxTopic))
    }

    @Test("rejects topic addressed to a different user (defensive — broker ACL should also block)")
    func rejectsWrongUser() {
        let result = parseInboxEnvelope(
            topic: "inbox/someone-else",
            payload: payload(#"{"session_id":"s1"}"#),
            expectedUserID: "user-abc"
        )
        #expect(result == .failure(.wrongUser(expected: "user-abc", got: "someone-else")))
    }

    @Test("rejects malformed JSON payload")
    func rejectsMalformedJSON() {
        let result = parseInboxEnvelope(
            topic: "inbox/user-abc",
            payload: Data([0xFF, 0xFE, 0xFD, 0x00]),
            expectedUserID: "user-abc"
        )
        #expect(result == .failure(.malformedPayload))
    }

    @Test("rejects valid JSON missing session_id")
    func rejectsMissingSessionId() {
        let result = parseInboxEnvelope(
            topic: "inbox/user-abc",
            payload: payload(#"{"ts":1700000000}"#),
            expectedUserID: "user-abc"
        )
        #expect(result == .failure(.malformedPayload))
    }

    @Test("rejects valid JSON with empty session_id")
    func rejectsEmptySessionId() {
        let result = parseInboxEnvelope(
            topic: "inbox/user-abc",
            payload: payload(#"{"session_id":""}"#),
            expectedUserID: "user-abc"
        )
        #expect(result == .failure(.missingSessionID))
    }
}
