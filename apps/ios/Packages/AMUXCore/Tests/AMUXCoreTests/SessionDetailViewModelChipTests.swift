import XCTest
import SwiftData
@testable import AMUXCore

final class SessionDetailViewModelChipTests: XCTestCase {
    @MainActor
    func test_bootstrapChips_singleAgent_selectsThatAgent() {
        let vm = SessionDetailViewModel.testInstance()
        vm.bootstrapChips(
            participants: [SessionParticipant.testFixture(actorID: "a1", role: "agent", displayName: "miniA")],
            runtimeStates: ["a1": .ready]
        )
        XCTAssertEqual(vm.agentChipSelection, ["a1"])
    }

    @MainActor
    func test_bootstrapChips_multiAgent_selectsNone() {
        let vm = SessionDetailViewModel.testInstance()
        vm.bootstrapChips(
            participants: [
                SessionParticipant.testFixture(actorID: "a1", role: "agent", displayName: "miniA"),
                SessionParticipant.testFixture(actorID: "a2", role: "agent", displayName: "miniB"),
            ],
            runtimeStates: ["a1": .ready, "a2": .spawning]
        )
        XCTAssertEqual(vm.agentChipSelection, [])
    }

    @MainActor
    func test_bootstrapChips_humanParticipant_excluded() {
        let vm = SessionDetailViewModel.testInstance()
        vm.bootstrapChips(
            participants: [
                SessionParticipant.testFixture(actorID: "h1", role: "human", displayName: "Alice"),
                SessionParticipant.testFixture(actorID: "a1", role: "agent", displayName: "miniA"),
            ],
            runtimeStates: ["a1": .ready]
        )
        // Only one agent → auto-selected; human excluded from chip participants.
        XCTAssertEqual(vm.agentChipSelection, ["a1"])
        XCTAssertEqual(vm.agentChipParticipants.count, 1)
        XCTAssertEqual(vm.agentChipParticipants.first?.id, "a1")
    }

    @MainActor
    func test_toggleAgentChip_addsAndRemoves() {
        let vm = SessionDetailViewModel.testInstance()
        vm.bootstrapChips(
            participants: [
                SessionParticipant.testFixture(actorID: "a1", role: "agent", displayName: "miniA"),
                SessionParticipant.testFixture(actorID: "a2", role: "agent", displayName: "miniB"),
            ],
            runtimeStates: [:]
        )
        XCTAssertTrue(vm.agentChipSelection.isEmpty)
        vm.toggleAgentChip("a1")
        XCTAssertEqual(vm.agentChipSelection, ["a1"])
        vm.toggleAgentChip("a1")
        XCTAssertTrue(vm.agentChipSelection.isEmpty)
    }

    @MainActor
    func test_handleIncomingChatMessage_filtersAgentReply() {
        let vm = SessionDetailViewModel.testInstance()
        var agentReply = Teamclaw_Message()
        agentReply.kind = .agentReply
        agentReply.content = "hello from agent"
        agentReply.senderActorID = "agent_X"
        vm._test_handleIncomingChatMessage(agentReply)
        XCTAssertEqual(vm.events.count, 0, "agent_reply must not create a user_prompt bubble")
    }

    @MainActor
    func test_handleIncomingChatMessage_allowsTextKind() {
        let vm = SessionDetailViewModel.testInstance()
        var textMsg = Teamclaw_Message()
        textMsg.kind = .text
        textMsg.content = "hello from another human"
        textMsg.senderActorID = "human_Y"
        textMsg.createdAt = Int64(Date().timeIntervalSince1970)
        vm._test_handleIncomingChatMessage(textMsg)
        XCTAssertEqual(vm.events.count, 1)
        XCTAssertEqual(vm.events.first?.eventType, "user_prompt")
    }

    @MainActor
    func test_handleIncomingChatMessage_filtersAgentThinking() {
        let vm = SessionDetailViewModel.testInstance()
        var msg = Teamclaw_Message()
        msg.kind = .agentThinking
        msg.content = "thinking..."
        msg.senderActorID = "agent_X"
        vm._test_handleIncomingChatMessage(msg)
        XCTAssertEqual(vm.events.count, 0, "agentThinking must be filtered")
    }

    @MainActor
    func test_bootstrapChips_legacyPrimaryAgent_synthesizesChip() {
        let vm = SessionDetailViewModel.testInstance()
        vm.bootstrapChips(
            participants: [],
            runtimeStates: ["legacy_a": .ready],
            legacyPrimaryAgentID: "legacy_a"
        )
        XCTAssertEqual(vm.agentChipSelection, ["legacy_a"])
        XCTAssertEqual(vm.agentChipParticipants.first?.id, "legacy_a")
    }

    @MainActor
    func test_bootstrapChips_legacyPrimaryAgent_ignoredWhenParticipantsExist() {
        let vm = SessionDetailViewModel.testInstance()
        let realParticipant = SessionParticipant(actorID: "new_a", role: "agent", displayName: "miniA")
        vm.bootstrapChips(
            participants: [realParticipant],
            runtimeStates: ["new_a": .ready, "legacy_a": .ready],
            legacyPrimaryAgentID: "legacy_a"  // should be ignored
        )
        XCTAssertEqual(vm.agentChipSelection, ["new_a"])
        XCTAssertEqual(vm.agentChipParticipants.count, 1)
        XCTAssertEqual(vm.agentChipParticipants.first?.id, "new_a")
    }

    @MainActor
    func test_bind_hydratesAgentChipSelectionFromSession() {
        let s = Session(sessionId: "s1")
        s.selectedAgentIds = ["a1", "a2"]
        let vm = SessionDetailViewModel.testInstance(session: s)
        XCTAssertEqual(vm.agentChipSelection, Set(["a1", "a2"]))
    }

    @MainActor
    func test_toggleAgentChip_persistsToSession() throws {
        let s = Session(sessionId: "s1")
        let vm = SessionDetailViewModel.testInstance(session: s)
        vm.toggleAgentChip("a1")
        XCTAssertEqual(Set(s.selectedAgentIds), Set(["a1"]))
        vm.toggleAgentChip("a2")
        XCTAssertEqual(Set(s.selectedAgentIds), Set(["a1", "a2"]))
        vm.toggleAgentChip("a1")
        XCTAssertEqual(Set(s.selectedAgentIds), Set(["a2"]))
    }

    @MainActor
    func test_lightAgentChip_persistsToSession() {
        let s = Session(sessionId: "s1")
        let vm = SessionDetailViewModel.testInstance(session: s)
        vm.lightAgentChip("a1")
        XCTAssertEqual(Set(s.selectedAgentIds), Set(["a1"]))
    }

    @MainActor
    func test_setAgentChipSelection_persistsToSession() {
        let s = Session(sessionId: "s1")
        let vm = SessionDetailViewModel.testInstance(session: s)
        vm.setAgentChipSelection(Set(["a1", "a2"]))
        XCTAssertEqual(Set(s.selectedAgentIds), Set(["a1", "a2"]))
    }

    @MainActor
    func test_bootstrapChips_skipsSingleAgentDefault_whenSessionAlreadyHasPersistedSelection() {
        let s = Session(sessionId: "s1")
        s.selectedAgentIds = []                          // user explicitly cleared
        let vm = SessionDetailViewModel.testInstance(session: s)
        // User-cleared empty state must survive bootstrap (no auto-relight).
        vm.bootstrapChips(
            participants: [SessionParticipant.testFixture(actorID: "a1", role: "agent", displayName: "miniA")],
            runtimeStates: ["a1": .ready]
        )
        XCTAssertEqual(vm.agentChipSelection, [])
    }

    @MainActor
    func test_bootstrapChips_appliesSingleAgentDefault_whenNoBoundSession() {
        let vm = SessionDetailViewModel.testInstance() // no session bound = new session
        vm.bootstrapChips(
            participants: [SessionParticipant.testFixture(actorID: "a1", role: "agent", displayName: "miniA")],
            runtimeStates: ["a1": .ready]
        )
        XCTAssertEqual(vm.agentChipSelection, ["a1"])
    }

    @MainActor
    func test_memberSheetRefresh_prunesGhostAgentsFromSelection() {
        let s = Session(sessionId: "s1")
        s.selectedAgentIds = ["a1", "a2", "ghost"]
        let vm = SessionDetailViewModel.testInstance(session: s)
        XCTAssertEqual(vm.agentChipSelection, Set(["a1", "a2", "ghost"]))

        vm.applyMemberSheetSnapshotForTests(agents: [
            MemberSheetAgent.testFixture(id: "a1"),
            MemberSheetAgent.testFixture(id: "a2"),
        ])

        XCTAssertEqual(vm.agentChipSelection, Set(["a1", "a2"]))
        XCTAssertEqual(Set(s.selectedAgentIds), Set(["a1", "a2"]))
    }
}
