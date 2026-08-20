import XCTest
import SwiftData
@testable import AMUXCore

/// `runtimeCommandRpc` — ACP commands ride `RpcRequest.runtime_command`
/// addressed by (actor, session), per ADR-0003. The retired
/// `runtime/{rid}/commands` topic had no reply path; these tests pin the
/// three answers the RPC channel gives that the old topic could not:
/// delivered, cold (no attachment), and rejected.
@MainActor
final class RuntimeCommandRpcTests: XCTestCase {
    private func makeModelContainer() throws -> ModelContainer {
        let schema = Schema([
            Session.self,
            SessionMessage.self,
            SessionIdea.self,
        ])
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: configuration)
    }

    private func configuredService(mqtt: MQTTService) async throws -> TeamcluService {
        let service = TeamcluService()
        let container = try makeModelContainer()
        service.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team1",
            peerId: "peer1",
            modelContainer: container,
            connectedAgentsStore: nil
        )
        service.setLocalMemberIdForTesting("member1")
        await service.hubRef?.start()
        await Task.yield()
        return service
    }

    private func awaitCapturedPayload(
        _ box: ActorBox<Data?>,
        maxAttempts: Int = 100
    ) async throws -> Data {
        var attempts = 0
        while await box.value == nil && attempts < maxAttempts {
            try await Task.sleep(for: .milliseconds(10))
            attempts += 1
        }
        guard let payload = await box.value else {
            XCTFail("publishHook never captured a payload")
            throw CancellationError()
        }
        return payload
    }

    private func makeCancelCommand() -> Amux_AcpCommand {
        var command = Amux_AcpCommand()
        command.command = .cancel(Amux_AcpCancel())
        return command
    }

    private func reply(
        _ mqtt: MQTTService,
        to request: Teamclu_RpcRequest,
        success: Bool,
        error: String = "",
        dispatched: Bool?
    ) throws {
        var response = Teamclu_RpcResponse()
        response.requestID = request.requestID
        response.success = success
        response.error = error
        if let dispatched {
            var result = Teamclu_RuntimeCommandResult()
            result.dispatched = dispatched
            response.result = .runtimeCommandResult(result)
        }
        mqtt.deliverForTesting(MQTTIncoming(
            topic: MQTTTopics.actorRpcResponse(teamID: "team1", actorID: "member1"),
            payload: try response.serializedData(),
            retained: false
        ))
    }

    func testDispatchedCommandCarriesSessionAddressAndSender() async throws {
        let captured = ActorBox<Data?>(nil)
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { _, payload, _ in
                await captured.set(payload)
            }
        )
        let service = try await configuredService(mqtt: mqtt)

        let command = makeCancelCommand()
        async let outcome = service.runtimeCommandRpc(
            targetActorID: "agent-a",
            sessionID: "s-1",
            address: "agent-a::s-1",
            command: command
        )

        let payload = try await awaitCapturedPayload(captured)
        let request = try Teamclu_RpcRequest(serializedBytes: payload)
        XCTAssertEqual(request.requesterActorID, "member1")
        guard case .runtimeCommand(let command) = request.method else {
            return XCTFail("expected runtime_command method")
        }
        XCTAssertEqual(command.sessionID, "s-1")
        XCTAssertEqual(command.envelope.runtimeID, "agent-a::s-1")
        XCTAssertEqual(command.envelope.actorID, "agent-a")
        XCTAssertEqual(command.envelope.senderActorID, "member1")
        guard case .cancel = command.envelope.acpCommand.command else {
            return XCTFail("expected cancel ACP command")
        }

        try reply(mqtt, to: request, success: true, dispatched: true)
        let (dispatched, error) = await outcome
        XCTAssertTrue(dispatched)
        XCTAssertNil(error)
    }

    func testColdSessionIsAnAnswerNotAnError() async throws {
        let captured = ActorBox<Data?>(nil)
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { _, payload, _ in
                await captured.set(payload)
            }
        )
        let service = try await configuredService(mqtt: mqtt)

        let command = makeCancelCommand()
        async let outcome = service.runtimeCommandRpc(
            targetActorID: "agent-a",
            sessionID: "s-1",
            address: "agent-a::s-1",
            command: command
        )

        let payload = try await awaitCapturedPayload(captured)
        let request = try Teamclu_RpcRequest(serializedBytes: payload)
        try reply(mqtt, to: request, success: true, dispatched: false)

        let (dispatched, error) = await outcome
        XCTAssertFalse(dispatched)
        XCTAssertNil(error)
    }

    func testRejectionSurfacesTheDaemonError() async throws {
        let captured = ActorBox<Data?>(nil)
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { _, payload, _ in
                await captured.set(payload)
            }
        )
        let service = try await configuredService(mqtt: mqtt)

        let command = makeCancelCommand()
        async let outcome = service.runtimeCommandRpc(
            targetActorID: "agent-a",
            sessionID: "s-1",
            address: "agent-a::s-1",
            command: command
        )

        let payload = try await awaitCapturedPayload(captured)
        let request = try Teamclu_RpcRequest(serializedBytes: payload)
        try reply(mqtt, to: request, success: false, error: "denied", dispatched: nil)

        let (dispatched, error) = await outcome
        XCTAssertFalse(dispatched)
        XCTAssertEqual(error, "denied")
    }

    func testReturnsErrorWhenMQTTNotConfigured() async {
        let service = TeamcluService()
        let (dispatched, error) = await service.runtimeCommandRpc(
            targetActorID: "agent-a",
            sessionID: "s-1",
            address: "agent-a::s-1",
            command: makeCancelCommand()
        )
        XCTAssertFalse(dispatched)
        XCTAssertEqual(error, "mqtt not configured")
    }
}
