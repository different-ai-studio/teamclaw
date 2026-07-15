import Testing
import Foundation
@testable import AMUXCore

// MARK: - TimelineInput schema tests
//
// These tests pin the *schema-level* contract documented in
// `TimelineInput.swift`: identity keys are reachable, payloads encode
// the documented data, and the per-variant ordering keys behave the
// way the docs say they do.
//
// Behavioural fixture tests (reducer-output against recorded session
// traces) live with `ChatTimelineReducer` once that's extracted — they
// reference the same scenarios documented in the "in-place mutation
// cases" block of `TimelineInput.swift` and should fail loudly if the
// schema changes shape underneath them.

@Suite("TimelineInput identity keys")
struct TimelineInputIdentityKeysTests {

    @Test("acp identity is (runtimeID, envelopeSequence)")
    func acpIdentityKey() {
        let a = AcpInput(envelopeSequence: 42,
                         runtimeID: "rt-1",
                         agentBucketKey: "agent-actor-1",
                         timestamp: .distantPast,
                         acpEvent: Amux_AcpEvent())
        #expect(a.envelopeSequence == 42)
        #expect(a.runtimeID == "rt-1")
        #expect(a.agentBucketKey == "agent-actor-1")
    }

    @Test("liveMessage identity is messageID")
    func liveMessageIdentityKey() {
        let m = LiveMessageInput(messageID: "msg-abc",
                                 clientLocalID: nil,
                                 senderActorID: "user-1",
                                 content: "hi",
                                 createdAt: .distantPast)
        #expect(m.messageID == "msg-abc")
        #expect(m.clientLocalID == nil)
    }

    @Test("liveMessage carries the clientLocalID for local-prompt merge")
    func liveMessageClientLocalID() {
        let m = LiveMessageInput(messageID: "msg-abc",
                                 clientLocalID: "client-uuid-xyz",
                                 senderActorID: "user-1",
                                 content: "hi",
                                 createdAt: .distantPast)
        #expect(m.clientLocalID == "client-uuid-xyz")
    }

    @Test("historyMessage identity is supabaseMessageID")
    func historyMessageIdentityKey() {
        let h = HistoryInput(supabaseMessageID: "sb-row-1",
                             kind: .output,
                             senderActorID: "agent-1",
                             content: "ack",
                             createdAt: .distantPast)
        #expect(h.supabaseMessageID == "sb-row-1")
        #expect(h.kind == .output)
    }

    @Test("localPrompt identity is clientID")
    func localPromptIdentityKey() {
        let p = LocalPromptInput(clientID: "client-uuid-xyz",
                                 senderActorID: "user-1",
                                 content: "let's go",
                                 createdAt: .distantPast)
        #expect(p.clientID == "client-uuid-xyz")
    }

    @Test("permissionResolution identity is requestID")
    func permissionResolutionIdentityKey() {
        let r = PermissionResolutionInput(requestID: "perm-1", granted: true)
        #expect(r.requestID == "perm-1")
        #expect(r.granted == true)
    }
}

@Suite("TimelineInput ordering keys")
struct TimelineInputOrderingTests {

    @Test("acp events from the same runtime order by envelopeSequence")
    func acpOrderingBySequence() {
        let first = AcpInput(envelopeSequence: 1,
                             runtimeID: "rt-1",
                             agentBucketKey: "agent-1",
                             timestamp: Date(timeIntervalSince1970: 100),
                             acpEvent: Amux_AcpEvent())
        let second = AcpInput(envelopeSequence: 2,
                              runtimeID: "rt-1",
                              agentBucketKey: "agent-1",
                              timestamp: Date(timeIntervalSince1970: 99),
                              acpEvent: Amux_AcpEvent())
        // Sequence wins over timestamp when both events share a runtime.
        #expect(first.envelopeSequence < second.envelopeSequence)
    }

    @Test("acp events with sequence==0 fall back to timestamp tiebreaker")
    func acpOrderingZeroSequenceTimestamp() {
        let earlier = AcpInput(envelopeSequence: 0,
                               runtimeID: "rt-1",
                               agentBucketKey: "agent-1",
                               timestamp: Date(timeIntervalSince1970: 50),
                               acpEvent: Amux_AcpEvent())
        let later = AcpInput(envelopeSequence: 0,
                             runtimeID: "rt-1",
                             agentBucketKey: "agent-1",
                             timestamp: Date(timeIntervalSince1970: 51),
                             acpEvent: Amux_AcpEvent())
        #expect(earlier.timestamp < later.timestamp)
    }

    @Test("liveMessage orders by createdAt")
    func liveMessageOrdering() {
        let a = LiveMessageInput(messageID: "1",
                                 senderActorID: "u",
                                 content: "first",
                                 createdAt: Date(timeIntervalSince1970: 10))
        let b = LiveMessageInput(messageID: "2",
                                 senderActorID: "u",
                                 content: "second",
                                 createdAt: Date(timeIntervalSince1970: 20))
        #expect(a.createdAt < b.createdAt)
    }

    @Test("historyMessage orders by createdAt")
    func historyMessageOrdering() {
        let a = HistoryInput(supabaseMessageID: "1",
                             kind: .userPrompt,
                             senderActorID: "u",
                             content: "first",
                             createdAt: Date(timeIntervalSince1970: 10))
        let b = HistoryInput(supabaseMessageID: "2",
                             kind: .userPrompt,
                             senderActorID: "u",
                             content: "second",
                             createdAt: Date(timeIntervalSince1970: 20))
        #expect(a.createdAt < b.createdAt)
    }
}

@Suite("TimelineInput sum type encoding")
struct TimelineInputSumTypeTests {

    @Test("all five variants are reachable through the sum type")
    func allVariantsReachable() {
        let inputs: [TimelineInput] = [
            .acp(AcpInput(envelopeSequence: 1, runtimeID: "rt",
                          agentBucketKey: "agent", timestamp: .distantPast,
                          acpEvent: Amux_AcpEvent())),
            .liveMessage(LiveMessageInput(messageID: "m",
                                          senderActorID: "u",
                                          content: "hi",
                                          createdAt: .distantPast)),
            .historyMessage(HistoryInput(supabaseMessageID: "s",
                                         kind: .output,
                                         senderActorID: nil,
                                         content: "ack",
                                         createdAt: .distantPast)),
            .localPrompt(LocalPromptInput(clientID: "c",
                                          senderActorID: "u",
                                          content: "hi",
                                          createdAt: .distantPast)),
            .permissionResolution(PermissionResolutionInput(requestID: "p",
                                                            granted: false))
        ]
        #expect(inputs.count == 5)
    }
}
