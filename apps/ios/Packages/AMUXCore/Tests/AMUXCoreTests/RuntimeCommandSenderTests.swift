import Testing
import Foundation
@testable import AMUXCore

@Suite("RuntimeCommandSender")
struct RuntimeCommandSenderTests {

    @Test("empty runtimeID throws runtimeIdEmpty before any publish")
    func emptyRuntimeIDThrows() async throws {
        let published = ConcurrencyBox<[(String, Data, Bool)]>(value: [])
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.mutate { $0.append((topic, payload, retain)) }
            }
        )
        let sender = RuntimeCommandSender(mqtt: mqtt, teamID: "team", peerID: "peer-1")

        do {
            try await sender.send(
                runtimeID: "",
                actorID: "device-1",
                currentHumanActorID: nil,
                makeCommand: { $0.command = .cancel(Amux_AcpCancel()) }
            )
            Issue.record("expected runtimeIdEmpty")
        } catch SendCommandError.runtimeIdEmpty {
            // expected
        }
        let after = await published.value
        #expect(after.isEmpty, "no publish should fire when runtimeID is empty")
    }

    @Test("empty actorID throws routeActorIdUnresolved before any publish")
    func emptyActorIDThrows() async throws {
        let published = ConcurrencyBox<[(String, Data, Bool)]>(value: [])
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.mutate { $0.append((topic, payload, retain)) }
            }
        )
        let sender = RuntimeCommandSender(mqtt: mqtt, teamID: "team", peerID: "peer-1")

        do {
            try await sender.send(
                runtimeID: "rt-1",
                actorID: "",
                currentHumanActorID: nil,
                makeCommand: { $0.command = .cancel(Amux_AcpCancel()) }
            )
            Issue.record("expected routeActorIdUnresolved")
        } catch SendCommandError.routeActorIdUnresolved {
            // expected
        }
        let after = await published.value
        #expect(after.isEmpty)
    }

    @Test("publish targets the runtime commands topic and stamps the sender actor id")
    func publishesCorrectTopicAndEnvelope() async throws {
        let published = ConcurrencyBox<[(String, Data, Bool)]>(value: [])
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.mutate { $0.append((topic, payload, retain)) }
            }
        )
        let sender = RuntimeCommandSender(mqtt: mqtt, teamID: "team-x", peerID: "peer-42")

        var g = Amux_AcpGrantPermission()
        g.requestID = "perm-1"
        try await sender.send(
            runtimeID: "rt-abcd",
            actorID: "dev-7",
            currentHumanActorID: "human-actor-1",
            makeCommand: { $0.command = .grantPermission(g) }
        )

        let snapshot = await published.value
        #expect(snapshot.count == 1)
        let (topic, data, retain) = try #require(snapshot.first)
        #expect(retain == false)
        #expect(topic == MQTTTopics.runtimeCommands(teamID: "team-x",
                                                   actorID: "dev-7",
                                                   runtimeID: "rt-abcd"))

        let envelope = try Amux_RuntimeCommandEnvelope(serializedBytes: data)
        #expect(envelope.runtimeID == "rt-abcd")
        #expect(envelope.actorID == "dev-7")
        #expect(envelope.peerID == "peer-42")
        #expect(envelope.senderActorID == "human-actor-1")
        #expect(envelope.hasAcpCommand)
        if case .grantPermission(let inner) = envelope.acpCommand.command {
            #expect(inner.requestID == "perm-1")
        } else {
            Issue.record("expected grantPermission ACP command")
        }
    }

    @Test("empty currentHumanActorID skips the senderActorID stamp")
    func emptyActorIDSkipsStamp() async throws {
        let published = ConcurrencyBox<[(String, Data, Bool)]>(value: [])
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.mutate { $0.append((topic, payload, retain)) }
            }
        )
        let sender = RuntimeCommandSender(mqtt: mqtt, teamID: "team", peerID: "peer")
        try await sender.send(
            runtimeID: "rt", actorID: "dev",
            currentHumanActorID: "",
            makeCommand: { $0.command = .cancel(Amux_AcpCancel()) }
        )
        let snapshot = await published.value
        let (_, data, _) = try #require(snapshot.first)
        let envelope = try Amux_RuntimeCommandEnvelope(serializedBytes: data)
        #expect(envelope.senderActorID.isEmpty)
    }
}

/// Tiny actor-isolated mutable box for shared state captured by
/// `@Sendable` publish hooks. Stdlib doesn't ship one and the existing
/// tests build their own; keep this self-contained per test file.
private actor ConcurrencyBox<T: Sendable> {
    var value: T
    init(value: T) { self.value = value }
    func mutate(_ f: @Sendable (inout T) -> Void) { f(&value) }
}
