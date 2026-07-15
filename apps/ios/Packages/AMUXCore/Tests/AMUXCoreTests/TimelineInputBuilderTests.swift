import Testing
import Foundation
@testable import AMUXCore

@Suite("TimelineInputBuilder")
struct TimelineInputBuilderTests {

    @Test("non-session-live topics yield nil")
    func filtersIrrelevantTopics() {
        let builder = TimelineInputBuilder()
        let runtimeState = MQTTIncoming(
            topic: "amux/team-x/actor-1/runtime/rt-1/state",
            payload: Data(),
            retained: true
        )
        #expect(builder.build(from: runtimeState) == nil)

        let actorState = MQTTIncoming(
            topic: "amux/team-x/actor-1/status",
            payload: Data(),
            retained: true
        )
        #expect(builder.build(from: actorState) == nil)
    }

    @Test("malformed payload on a session/live topic yields nil rather than crashing")
    func malformedPayloadGracefullyDropped() {
        let builder = TimelineInputBuilder()
        let bogus = MQTTIncoming(
            topic: "amux/team-x/session/sess-1/live",
            payload: Data([0xFF, 0xFE, 0xFD]),
            retained: false
        )
        #expect(builder.build(from: bogus) == nil)
    }

    @Test("a recorded smoke-cold-start trace contains no session/live records (yields zero inputs)")
    func smokeColdStartTraceYieldsZeroInputs() throws {
        // Recorded from running AMUXAuthUITests/testSignInAndMQTTConnects
        // with TeamclawRecordMQTT enabled. The smoke test never opens a
        // session detail view, so it has zero session/live messages —
        // every record in the trace is `runtime/{id}/state` or device
        // metadata. Use it to verify the builder filters cleanly.
        let url = try #require(
            Bundle.module.url(forResource: "smoke-cold-start", withExtension: "jsonl"),
            "smoke-cold-start.jsonl fixture is missing from the test bundle"
        )
        let raw = try String(contentsOf: url, encoding: .utf8)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let records: [MQTTTraceRecord] = raw
            .split(separator: "\n")
            .compactMap { line in
                try? decoder.decode(MQTTTraceRecord.self, from: Data(line.utf8))
            }
        #expect(!records.isEmpty,
                "fixture should contain captured records")

        let builder = TimelineInputBuilder()
        let inputs = builder.build(from: records)
        #expect(inputs.isEmpty,
                "cold-start smoke captures only runtime/state + device metadata; no session/live messages")
    }

    @Test("session/live message envelope decodes into a .liveMessage with the text content")
    func liveMessageDecodes() throws {
        var message = Teamclaw_Message()
        message.messageID = "msg-server-1"
        message.senderActorID = "user-1"
        message.content = "hello"
        message.kind = .text
        message.createdAt = 1_700_000_000

        var messageEnvelope = Teamclaw_SessionMessageEnvelope()
        messageEnvelope.message = message

        var live = Teamclaw_LiveEventEnvelope()
        live.eventType = "message.created"
        live.body = try messageEnvelope.serializedData()

        let incoming = MQTTIncoming(
            topic: "amux/team-x/session/sess-1/live",
            payload: try live.serializedData(),
            retained: false
        )

        let builder = TimelineInputBuilder()
        let input = builder.build(from: incoming)
        guard case .liveMessage(let lm)? = input else {
            Issue.record("expected .liveMessage, got \(String(describing: input))")
            return
        }
        #expect(lm.messageID == "msg-server-1")
        #expect(lm.senderActorID == "user-1")
        #expect(lm.content == "hello")
    }

    @Test("session/live acp.event envelope decodes into an .acp with the resolved bucket key")
    func acpEventDecodes() throws {
        var output = Amux_AcpOutput()
        output.text = "hi"
        output.isComplete = true

        var acp = Amux_AcpEvent()
        acp.event = .output(output)

        var amuxEnvelope = Amux_Envelope()
        amuxEnvelope.sequence = 42
        amuxEnvelope.runtimeID = "rt-claude"
        amuxEnvelope.payload = .acpEvent(acp)

        var live = Teamclaw_LiveEventEnvelope()
        live.eventType = "acp.event"
        live.body = try amuxEnvelope.serializedData()

        let incoming = MQTTIncoming(
            topic: "amux/team-x/session/sess-1/live",
            payload: try live.serializedData(),
            retained: false
        )

        // With a mapping, agentBucketKey resolves to the agent actor id.
        let mapped = TimelineInputBuilder(agentActorIDByRuntimeID: ["rt-claude": "agent-actor-1"])
        guard case .acp(let a)? = mapped.build(from: incoming) else {
            Issue.record("expected .acp")
            return
        }
        #expect(a.envelopeSequence == 42)
        #expect(a.runtimeID == "rt-claude")
        #expect(a.agentBucketKey == "agent-actor-1",
                "bucket key resolves through the mapping when present")

        // Without a mapping, agentBucketKey falls back to the raw runtimeID.
        let unmapped = TimelineInputBuilder()
        guard case .acp(let b)? = unmapped.build(from: incoming) else {
            Issue.record("expected .acp")
            return
        }
        #expect(b.agentBucketKey == "rt-claude")
    }
}
