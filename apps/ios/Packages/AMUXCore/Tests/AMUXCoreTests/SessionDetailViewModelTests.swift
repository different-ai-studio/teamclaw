import XCTest
import SwiftData
@testable import AMUXCore

@MainActor
final class SessionDetailViewModelTests: XCTestCase {
    private actor PublishedMessages {
        private(set) var value: [(String, Data, Bool)] = []

        func append(_ message: (String, Data, Bool)) {
            value.append(message)
        }
    }

    private func makeAgent(actorID: String, runtimeID: String?) -> MemberSheetAgent {
        MemberSheetAgent(
            id: actorID,
            displayName: actorID,
            workspacePath: "",
            agentType: "Claude",
            runtimeState: .ready,
            availableModels: [],
            currentModel: nil,
            runtimeID: runtimeID,
            workspaceID: nil,
            backendType: "claude"
        )
    }

    func testStartPrunesPersistedSameAgentOutputPrefixDuplicate() async throws {
        let container = try ModelContainer(
            for: Session.self, Runtime.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = container.mainContext
        let session = Session(sessionId: "session-1", teamId: "team-1")
        context.insert(session)

        let full = AgentEvent(agentId: "session-1", sequence: 41, eventType: "output")
        full.senderActorID = "agent-1"
        full.text = "I found the existing iOS pieces:\n- CreateIdeaSheet\n- AttachmentUploadManager"
        full.isComplete = true
        full.supabaseMessageId = "sb-full"
        full.turnID = "turn-1"
        full.timestamp = Date(timeIntervalSince1970: 1)
        context.insert(full)

        let prefix = AgentEvent(agentId: "session-1", sequence: 640, eventType: "output")
        prefix.senderActorID = "agent-1"
        prefix.text = "I found the existing iOS pieces:"
        prefix.isComplete = true
        prefix.timestamp = Date(timeIntervalSince1970: 2)
        context.insert(prefix)
        try context.save()

        let mqtt = MQTTService()
        let viewModel = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamclawService: nil
        )

        viewModel.start(modelContext: context)
        defer { viewModel.stop() }

        XCTAssertEqual(viewModel.events.filter { $0.eventType == "output" }.count, 1)
        XCTAssertEqual(viewModel.events.first?.text, full.text)
        XCTAssertEqual(viewModel.events.first?.supabaseMessageId, "sb-full")
    }

    func testSessionPromptUsesSessionLiveTransportEvenWithPlaceholderRuntime() async throws {
        let published = PublishedMessages()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.append((topic, payload, retain))
            }
        )
        let teamclawService = TeamclawService()
        let container = try ModelContainer(
            for: Session.self, Runtime.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        teamclawService.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team-1",
            peerId: "peer-1",
            modelContainer: container
        )
        teamclawService.setLocalMemberIdForTesting("human-1")

        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-actor-1"
        let placeholder = Runtime(runtimeId: "agent-actor-1")
        placeholder.routeActorID = "daemon-device-1"

        let viewModel = SessionDetailViewModel(
            runtime: placeholder,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamclawService: teamclawService
        )

        try await viewModel.sendPrompt("second turn")
        try await Task.sleep(for: .milliseconds(50))

        let snapshot = await published.value
        XCTAssertEqual(snapshot.count, 1)
        XCTAssertEqual(
            snapshot.first?.0,
            MQTTTopics.sessionLive(teamID: "team-1", sessionID: "session-1")
        )
        XCTAssertFalse(snapshot.first?.2 ?? true)
    }

    func testGrantPermissionRoutesToPermissionSourceRuntime() async throws {
        let published = PublishedMessages()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.append((topic, payload, retain))
            }
        )

        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-primary"
        let primaryRuntime = Runtime(runtimeId: "rt-primary")
        primaryRuntime.routeActorID = "daemon-device-1"

        let viewModel = SessionDetailViewModel(
            runtime: primaryRuntime,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session
        )
        viewModel._test_setMemberSheetAgentsAndRelabel([
            makeAgent(actorID: "agent-primary", runtimeID: "rt-primary"),
            makeAgent(actorID: "agent-secondary", runtimeID: "rt-secondary")
        ])

        try await viewModel.grantPermission(requestId: "perm-1", agentActorID: "agent-secondary")

        let snapshot = await published.value
        XCTAssertEqual(snapshot.count, 1)
        let (topic, data, retain) = try XCTUnwrap(snapshot.first)
        XCTAssertFalse(retain)
        XCTAssertEqual(
            topic,
            MQTTTopics.runtimeCommands(teamID: "team-1", actorID: "daemon-device-1", runtimeID: "rt-secondary")
        )
        let envelope = try Amux_RuntimeCommandEnvelope(serializedBytes: data)
        XCTAssertEqual(envelope.runtimeID, "rt-secondary")
        if case .grantPermission(let grant) = envelope.acpCommand.command {
            XCTAssertEqual(grant.requestID, "perm-1")
        } else {
            XCTFail("expected grantPermission ACP command")
        }
    }

    func testGrantPermissionRoutesEvenWhenDetailRuntimeIsNil() async throws {
        let published = PublishedMessages()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.append((topic, payload, retain))
            }
        )
        let container = try ModelContainer(
            for: Session.self, Runtime.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        let context = container.mainContext

        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-secondary"
        context.insert(session)

        let secondaryRuntime = Runtime(runtimeId: "rt-secondary")
        secondaryRuntime.routeActorID = "daemon-device-2"
        context.insert(secondaryRuntime)
        try context.save()

        let viewModel = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session
        )
        viewModel._test_setMemberSheetAgentsAndRelabel([
            makeAgent(actorID: "agent-secondary", runtimeID: "rt-secondary")
        ])
        viewModel.start(modelContext: context)
        defer { viewModel.stop() }

        try await viewModel.grantPermission(requestId: "perm-2", agentActorID: "agent-secondary")

        let snapshot = await published.value
        XCTAssertEqual(snapshot.count, 1)
        let (topic, data, retain) = try XCTUnwrap(snapshot.first)
        XCTAssertFalse(retain)
        XCTAssertEqual(
            topic,
            MQTTTopics.runtimeCommands(teamID: "team-1", actorID: "daemon-device-2", runtimeID: "rt-secondary")
        )
        let envelope = try Amux_RuntimeCommandEnvelope(serializedBytes: data)
        XCTAssertEqual(envelope.runtimeID, "rt-secondary")
        if case .grantPermission(let grant) = envelope.acpCommand.command {
            XCTAssertEqual(grant.requestID, "perm-2")
        } else {
            XCTFail("expected grantPermission ACP command")
        }
    }

    /// Regression test for "agent loading takes a long time after send".
    ///
    /// Before the fix, the `ActiveStreamCardView` was driven solely by
    /// `streamingAgentSet`, which only got populated when the first ACP
    /// text delta arrived over MQTT — typically seconds after the user
    /// tapped send. After the fix, `recomputeGroups()` unions
    /// `streamingAgentSet` with the computed `streamingAgentIDs` (which
    /// reads `isAgentWorking`), and `markAgentWorking()` triggers a
    /// re-render. So feedItems must contain an `.activeStream` for the
    /// engaged agent immediately after `sendPrompt` returns.
    func testSendPromptSurfacesActiveStreamCardImmediately() async throws {
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { _, _, _ in }
        )
        let teamclawService = TeamclawService()
        let container = try ModelContainer(
            for: Session.self, Runtime.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        teamclawService.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team-1",
            peerId: "peer-1",
            modelContainer: container
        )
        teamclawService.setLocalMemberIdForTesting("human-1")

        let context = container.mainContext
        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-actor-1"
        context.insert(session)
        let agentRuntime = Runtime(runtimeId: "agent-actor-1")
        agentRuntime.routeActorID = "daemon-device-1"
        context.insert(agentRuntime)
        try context.save()

        let viewModel = SessionDetailViewModel(
            runtime: agentRuntime,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamclawService: teamclawService
        )
        viewModel._test_setMemberSheetAgentsAndRelabel([
            makeAgent(actorID: "agent-actor-1", runtimeID: "agent-actor-1")
        ])

        // Precondition: no busy state and no active-stream card.
        XCTAssertFalse(viewModel.isAgentWorking)
        XCTAssertFalse(viewModel.feedItems.contains(where: { item in
            if case .activeStream = item { return true }
            return false
        }))

        try await viewModel.sendPrompt("hello", modelContext: context)

        // Postcondition: busy flag is up AND the feed shows the
        // active-stream card for the engaged agent — without waiting
        // for any ACP delta to round-trip.
        XCTAssertTrue(viewModel.isAgentWorking)
        let activeStreamForAgent = viewModel.feedItems.contains { item in
            if case .activeStream(_, let agentID, let runtimeEvents) = item {
                return agentID == "agent-actor-1" && runtimeEvents.isEmpty
            }
            return false
        }
        XCTAssertTrue(
            activeStreamForAgent,
            "Expected an .activeStream feed item for agent-actor-1 with empty runtimeEvents immediately after sendPrompt"
        )
    }

    func testInterruptAgentInSessionModePublishesCancelToThatAgentsRuntime() async throws {
        let published = PublishedMessages()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                await published.append((topic, payload, retain))
            }
        )
        let teamclawService = TeamclawService()
        let container = try ModelContainer(
            for: Session.self, Runtime.self, AgentEvent.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true)
        )
        teamclawService.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team-1",
            peerId: "peer-1",
            modelContainer: container
        )
        teamclawService.setLocalMemberIdForTesting("human-1")

        let context = container.mainContext
        let session = Session(sessionId: "session-1", teamId: "team-1")
        session.primaryAgentId = "agent-actor-1"
        context.insert(session)
        let agentRuntime = Runtime(runtimeId: "rt-mini-1")
        agentRuntime.routeActorID = "daemon-device-1"
        context.insert(agentRuntime)
        try context.save()

        let viewModel = SessionDetailViewModel(
            runtime: nil,
            mqtt: mqtt,
            hub: MQTTMessageHub(mqtt: mqtt),
            teamID: "team-1",
            peerId: "peer-1",
            session: session,
            teamclawService: teamclawService
        )
        viewModel._test_setMemberSheetAgentsAndRelabel([
            makeAgent(actorID: "agent-actor-1", runtimeID: "rt-mini-1")
        ])
        viewModel.start(modelContext: context)
        defer { viewModel.stop() }

        viewModel.interruptAgent("agent-actor-1")
        try await Task.sleep(for: .milliseconds(50))

        let snapshot = await published.value
        XCTAssertEqual(snapshot.count, 1)
        XCTAssertEqual(
            snapshot.first?.0,
            MQTTTopics.runtimeCommands(
                teamID: "team-1",
                actorID: "daemon-device-1",
                runtimeID: "rt-mini-1"
            )
        )
        XCTAssertFalse(snapshot.first?.2 ?? true)

        let payload = try XCTUnwrap(snapshot.first?.1)
        let envelope = try Amux_RuntimeCommandEnvelope(serializedBytes: payload)
        XCTAssertEqual(envelope.runtimeID, "rt-mini-1")
        XCTAssertEqual(envelope.actorID, "daemon-device-1")
        XCTAssertEqual(envelope.senderActorID, "human-1")
        guard case .cancel = envelope.acpCommand.command else {
            return XCTFail("expected AcpCancel command")
        }
    }
}
