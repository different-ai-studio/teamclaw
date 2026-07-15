import XCTest
import SwiftData
@testable import AMUXCore

/// Thread-safe accumulator for MQTT publishes captured from the `@Sendable`
/// `publishHook`. Swift 6 forbids mutating a captured `var` from inside the
/// hook closure; this locked box lets the closure record publishes while tests
/// read them back with the same `count` / subscript API as a plain array.
private final class PublishLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [(String, Data, Bool)] = []
    func append(_ item: (String, Data, Bool)) { lock.lock(); items.append(item); lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return items.count }
    subscript(_ index: Int) -> (String, Data, Bool) {
        lock.lock(); defer { lock.unlock() }; return items[index]
    }
}

@MainActor
final class TeamclawServiceSubscriptionTests: XCTestCase {

    /// In-memory `AgentAccessRepository` returning a fixed agent set so tests
    /// can drive `ConnectedAgentsStore.agents` deterministically. The
    /// real Supabase-backed repository requires network and JWT.
    private final class FakeAgentAccessRepository: AgentAccessRepository, @unchecked Sendable {
        let agents: [ConnectedAgent]
        init(agents: [ConnectedAgent]) { self.agents = agents }
        func listConnectedAgents(teamID: String) async throws -> [ConnectedAgent] { agents }
        func listAuthorizedHumans(agentID: String) async throws -> [AgentAuthorizedHuman] { [] }
        func canManageAuthorizedHumans(agentID: String) async throws -> Bool { false }
        func grantAuthorizedHuman(agentID: String, memberID: String, permissionLevel: String) async throws {}
        func shareAgentToTeam(agentID: String) async throws {}
        func makeAgentPersonal(agentID: String) async throws {}
        func teamAgentCount(teamID: String) async throws -> Int { agents.count }
    }

    private func makeStore(actorID: String) async -> ConnectedAgentsStore {
        let agent = ConnectedAgent(
            id: actorID,
            displayName: "Test",
            agentKind: "daemon",
            permissionLevel: "owner",
            lastActiveAt: .now
        )
        let repo = FakeAgentAccessRepository(agents: [agent])
        let store = ConnectedAgentsStore(teamID: "team1", repository: repo)
        await store.reload()
        return store
    }

    private func waitForSubscribedTopic(
        _ topic: String,
        in mqtt: MQTTService,
        attempts: Int = 20
    ) async -> Bool {
        for _ in 0..<attempts {
            if mqtt.subscribedTopics.contains(topic) { return true }
            try? await Task.sleep(for: .milliseconds(25))
        }
        return mqtt.subscribedTopics.contains(topic)
    }

    func testStartRehydratesForegroundSessionSubscriptionsOnNewMQTTRuntime() async throws {
        let firstMQTT = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in }
        )
        let service = TeamclawService()
        let container = try makeModelContainer()
        let modelContext = ModelContext(container)
        let store = await makeStore(actorID: "actor1")

        service.configureRuntimeForTesting(
            mqtt: firstMQTT,
            teamId: "team1",
            peerId: "peer1",
            modelContainer: container,
            connectedAgentsStore: store
        )

        try await service.beginForegroundSession("sess-1")
        XCTAssertEqual(service.foregroundSessionIDs, ["sess-1"])

        let restartedMQTT = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in }
        )

        service.start(
            mqtt: restartedMQTT,
            hub: MQTTMessageHub(mqtt: restartedMQTT),
            teamId: "team1",
            peerId: "peer1",
            modelContext: modelContext,
            connectedAgentsStore: store,
            currentActorID: "member1"
        )

        await Task.yield()
        let liveTopic = MQTTTopics.sessionLive(teamID: "team1", sessionID: "sess-1")
        let didSubscribeLiveTopic = await waitForSubscribedTopic(liveTopic, in: restartedMQTT)
        XCTAssertTrue(didSubscribeLiveTopic)

        XCTAssertEqual(
            Set(restartedMQTT.subscribedTopics),
            Set([
                // notify per connected-agent actor
                MQTTTopics.actorNotify(teamID: "team1", actorID: "actor1"),
                // RPC responses on OUR OWN actor (daemon replies to requester)
                MQTTTopics.actorRpcResponse(teamID: "team1", actorID: "member1"),
                liveTopic,
            ])
        )
        XCTAssertEqual(service.foregroundSessionIDs, ["sess-1"])

        service.stop()
    }

    func testMembershipRefreshNotifyUsesExplicitRefreshPath() async throws {
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in }
        )
        let service = TeamclawService()
        let container = try makeModelContainer()
        let store = await makeStore(actorID: "actor1")

        service.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team1",
            peerId: "peer1",
            modelContainer: container,
            connectedAgentsStore: store
        )

        var notify = Teamclaw_Notify()
        notify.eventType = "membership.refresh"
        notify.refreshHint = "sess-1"

        await service.handleIncomingForTesting(
            MQTTIncoming(
                topic: MQTTTopics.actorNotify(teamID: "team1", actorID: "actor1"),
                payload: try notify.serializedData(),
                retained: false
            )
        )

        XCTAssertEqual(service.refreshedSessionIDs, ["sess-1"])
        XCTAssertTrue(service.foregroundSessionIDs.isEmpty)
    }

    func testMembershipRefreshNotifyFetchesSessionInfoWithoutMessageBackfillForBackgroundSession() async throws {
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in }
        )
        let service = TeamclawService()
        let container = try makeModelContainer()
        let store = await makeStore(actorID: "actor1")

        service.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team1",
            peerId: "peer1",
            modelContainer: container,
            connectedAgentsStore: store
        )

        var notify = Teamclaw_Notify()
        notify.eventType = "membership.refresh"
        notify.refreshHint = "sess-background"

        await service.handleIncomingForTesting(
            MQTTIncoming(
                topic: MQTTTopics.actorNotify(teamID: "team1", actorID: "actor1"),
                payload: try notify.serializedData(),
                retained: false
            )
        )

        XCTAssertEqual(service.refreshedSessionIDs, ["sess-background"])
        XCTAssertEqual(service.fetchSessionInfoCalls, ["sess-background"])
        XCTAssertTrue(service.fetchRecentMessagesCalls.isEmpty)
        XCTAssertTrue(service.foregroundSessionIDs.isEmpty)
    }

    func testMembershipRefreshNotifyBackfillsMessagesForForegroundSession() async throws {
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in }
        )
        let service = TeamclawService()
        let container = try makeModelContainer()
        let store = await makeStore(actorID: "actor1")

        service.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team1",
            peerId: "peer1",
            modelContainer: container,
            connectedAgentsStore: store
        )

        try await service.beginForegroundSession("sess-foreground")
        XCTAssertEqual(service.fetchRecentMessagesCalls, ["sess-foreground"])

        var notify = Teamclaw_Notify()
        notify.eventType = "membership.refresh"
        notify.refreshHint = "sess-foreground"

        await service.handleIncomingForTesting(
            MQTTIncoming(
                topic: MQTTTopics.actorNotify(teamID: "team1", actorID: "actor1"),
                payload: try notify.serializedData(),
                retained: false
            )
        )

        XCTAssertEqual(service.refreshedSessionIDs, ["sess-foreground"])
        XCTAssertEqual(service.fetchSessionInfoCalls, ["sess-foreground"])
        XCTAssertEqual(service.fetchRecentMessagesCalls, ["sess-foreground", "sess-foreground"])
        XCTAssertEqual(service.foregroundSessionIDs, ["sess-foreground"])
    }

    func testBeginForegroundSessionSubscribesToLiveTopicAndFetchesHistoryOnce() async throws {
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in }
        )
        let service = TeamclawService()
        let container = try makeModelContainer()
        let store = await makeStore(actorID: "actor1")

        service.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team1",
            peerId: "peer1",
            modelContainer: container,
            connectedAgentsStore: store
        )

        try await service.beginForegroundSession("sess-1")

        XCTAssertEqual(
            mqtt.subscribedTopics,
            [MQTTTopics.sessionLive(teamID: "team1", sessionID: "sess-1")]
        )
        XCTAssertEqual(service.foregroundSessionIDs, ["sess-1"])
        XCTAssertEqual(service.fetchRecentMessagesCalls, ["sess-1"])

        try await service.beginForegroundSession("sess-1")

        XCTAssertEqual(
            mqtt.subscribedTopics,
            [MQTTTopics.sessionLive(teamID: "team1", sessionID: "sess-1")]
        )
        XCTAssertEqual(service.fetchRecentMessagesCalls, ["sess-1"])
    }

    func testSendMessagePublishesLiveEventTopic() async throws {
        let published = PublishLog()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                published.append((topic, payload, retain))
            }
        )
        let service = TeamclawService()
        let container = try makeModelContainer()
        let store = await makeStore(actorID: "actor1")

        service.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team1",
            peerId: "peer1",
            modelContainer: container,
            connectedAgentsStore: store
        )

        // Phase 2b: localMemberId is now resolved via FetchPeers RPC on connect.
        // Set it directly so sendMessage's actor-id guard passes in this unit test.
        service.setLocalMemberIdForTesting("member1")

        try await service.sendMessage(sessionId: "sess-1", content: "hello")
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(published.count, 1)
        XCTAssertEqual(published[0].0, MQTTTopics.sessionLive(teamID: "team1", sessionID: "sess-1"))
        XCTAssertFalse(published[0].2)
    }

    /// Reproduces a reported regression where the second user message on a
    /// session never reaches the daemon. We call `sendMessage` twice on the
    /// same session and verify both publishes hit MQTT with the expected
    /// topic — no localMemberId reset, no stale state, no swallowed errors.
    func testSendMessageTwiceInSameSessionPublishesTwice() async throws {
        let published = PublishLog()
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in },
            publishHook: { topic, payload, retain in
                published.append((topic, payload, retain))
            }
        )
        let service = TeamclawService()
        let container = try makeModelContainer()
        let store = await makeStore(actorID: "actor1")

        service.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team1",
            peerId: "peer1",
            modelContainer: container,
            connectedAgentsStore: store
        )
        service.setLocalMemberIdForTesting("member1")

        try await service.sendMessage(sessionId: "sess-1", content: "first")
        try await service.sendMessage(sessionId: "sess-1", content: "second")
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertEqual(published.count, 2,
                       "Both messages should publish — second message regression check")
        let expectedTopic = MQTTTopics.sessionLive(teamID: "team1", sessionID: "sess-1")
        XCTAssertEqual(published[0].0, expectedTopic)
        XCTAssertEqual(published[1].0, expectedTopic)

        let firstEnv = try Teamclaw_LiveEventEnvelope(serializedBytes: published[0].1)
        let secondEnv = try Teamclaw_LiveEventEnvelope(serializedBytes: published[1].1)
        XCTAssertEqual(firstEnv.eventType, "message.created")
        XCTAssertEqual(secondEnv.eventType, "message.created")
        XCTAssertNotEqual(firstEnv.eventID, secondEnv.eventID,
                          "Each publish should carry a fresh event_id")

        let firstMsg = try Teamclaw_SessionMessageEnvelope(serializedBytes: firstEnv.body).message
        let secondMsg = try Teamclaw_SessionMessageEnvelope(serializedBytes: secondEnv.body).message
        XCTAssertEqual(firstMsg.content, "first")
        XCTAssertEqual(secondMsg.content, "second")
        XCTAssertEqual(firstMsg.senderActorID, "member1")
        XCTAssertEqual(secondMsg.senderActorID, "member1")
        XCTAssertNotEqual(firstMsg.messageID, secondMsg.messageID)
    }

    func testEndForegroundSessionUnsubscribesLiveTopic() async throws {
        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in }
        )
        let service = TeamclawService()
        let container = try makeModelContainer()
        let store = await makeStore(actorID: "actor1")

        service.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team1",
            peerId: "peer1",
            modelContainer: container,
            connectedAgentsStore: store
        )

        try await service.beginForegroundSession("sess-1")
        try await service.beginForegroundSession("sess-2")

        try await service.endForegroundSession("sess-1")

        XCTAssertEqual(
            mqtt.unsubscribedTopics,
            [MQTTTopics.sessionLive(teamID: "team1", sessionID: "sess-1")]
        )
        XCTAssertEqual(service.foregroundSessionIDs, ["sess-2"])
    }

    func testStopClearsForegroundSubscriptions() async throws {
        let stopUnsubscribeExpectation = expectation(description: "stop unsubscribes live topics")
        stopUnsubscribeExpectation.expectedFulfillmentCount = 2

        let mqtt = MQTTService(
            subscribeHook: { _ in },
            unsubscribeHook: { _ in
                stopUnsubscribeExpectation.fulfill()
            }
        )
        let service = TeamclawService()
        let container = try makeModelContainer()
        let store = await makeStore(actorID: "actor1")

        service.configureRuntimeForTesting(
            mqtt: mqtt,
            teamId: "team1",
            peerId: "peer1",
            modelContainer: container,
            connectedAgentsStore: store
        )

        try await service.beginForegroundSession("sess-1")
        try await service.beginForegroundSession("sess-2")

        service.stop()

        await fulfillment(of: [stopUnsubscribeExpectation], timeout: 1.0)
        try await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(
            Set(mqtt.unsubscribedTopics),
            Set([
                MQTTTopics.sessionLive(teamID: "team1", sessionID: "sess-1"),
                MQTTTopics.sessionLive(teamID: "team1", sessionID: "sess-2"),
            ])
        )
        XCTAssertTrue(service.foregroundSessionIDs.isEmpty)
    }

    private func makeModelContainer() throws -> ModelContainer {
        let schema = Schema([
            Session.self,
            SessionMessage.self,
            SessionIdea.self,
        ])
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: configuration)
    }
}
