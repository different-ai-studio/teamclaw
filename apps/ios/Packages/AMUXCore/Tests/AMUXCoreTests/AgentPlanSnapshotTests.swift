import Foundation
import SwiftData
import Testing
@testable import AMUXCore

@Suite("AgentPlanSnapshot.derive")
struct AgentPlanSnapshotTests {

    /// Build an AgentEvent in-memory. SwiftData @Model objects don't need
    /// a container for construction — only for queries/inserts.
    private func makeEvent(
        agentId: String,
        sequence: Int,
        type: String,
        text: String? = nil,
        senderActorID: String? = nil
    ) -> AgentEvent {
        let event = AgentEvent(agentId: agentId, sequence: sequence, eventType: type)
        event.text = text
        event.senderActorID = senderActorID
        return event
    }

    private let nameProvider: (String) -> String = { id in "agent-\(id.prefix(3))" }

    @Test("empty events → empty snapshots")
    func emptyEvents() {
        let result = AgentPlanSnapshot.derive(events: [], agentNameFor: nameProvider)
        #expect(result == [])
    }

    @Test("single agent with one [wip] item → one snapshot, unfinished")
    func singleAgentUnfinished() {
        let events = [
            makeEvent(agentId: "aaa1", sequence: 1, type: "plan_update", text: "[wip] do thing\n[done] other")
        ]
        let result = AgentPlanSnapshot.derive(events: events, agentNameFor: nameProvider)
        #expect(result.count == 1)
        #expect(result[0].agentID == "aaa1")
        #expect(result[0].agentName == "agent-aaa")
        #expect(result[0].items.count == 2)
        #expect(result[0].hasUnfinished == true)
    }

    @Test("single agent with all [done] items → snapshot filtered out")
    func singleAgentAllDone() {
        let events = [
            makeEvent(agentId: "aaa1", sequence: 1, type: "plan_update", text: "[done] a\n[done] b")
        ]
        let result = AgentPlanSnapshot.derive(events: events, agentNameFor: nameProvider)
        #expect(result == [])
    }

    @Test("[cancelled] items don't count as unfinished")
    func cancelledIsFinished() {
        let events = [
            makeEvent(agentId: "aaa1", sequence: 1, type: "plan_update", text: "[done] a\n[cancelled] b")
        ]
        let result = AgentPlanSnapshot.derive(events: events, agentNameFor: nameProvider)
        #expect(result == [])
    }

    @Test("two agents with unfinished plans → two snapshots ordered by first appearance")
    func twoAgentsOrderedByAppearance() {
        let events = [
            makeEvent(agentId: "bbb2", sequence: 1, type: "plan_update", text: "[wip] b-task"),
            makeEvent(agentId: "aaa1", sequence: 2, type: "plan_update", text: "[wip] a-task"),
        ]
        let result = AgentPlanSnapshot.derive(events: events, agentNameFor: nameProvider)
        #expect(result.count == 2)
        // bbb2 appeared first → page 0
        #expect(result[0].agentID == "bbb2")
        #expect(result[1].agentID == "aaa1")
    }

    @Test("plan snapshots group by senderActorID when persisted agentId is session-scoped")
    func senderActorIDWinsOverSessionScopedAgentID() {
        let events = [
            makeEvent(
                agentId: "session-scope",
                sequence: 1,
                type: "plan_update",
                text: "[wip] b-task",
                senderActorID: "bbb2"
            ),
            makeEvent(
                agentId: "session-scope",
                sequence: 2,
                type: "plan_update",
                text: "[wip] a-task",
                senderActorID: "aaa1"
            ),
        ]
        let result = AgentPlanSnapshot.derive(events: events, agentNameFor: nameProvider)
        #expect(result.count == 2)
        if result.count == 2 {
            #expect(result[0].agentID == "bbb2")
            #expect(result[1].agentID == "aaa1")
        }
    }

    @Test("same agent emits two plan_updates → latest text wins")
    func snapshotReplacement() {
        let events = [
            makeEvent(agentId: "aaa1", sequence: 1, type: "plan_update", text: "[wip] old"),
            makeEvent(agentId: "aaa1", sequence: 2, type: "plan_update", text: "[wip] new\n[todo] also new"),
        ]
        let result = AgentPlanSnapshot.derive(events: events, agentNameFor: nameProvider)
        #expect(result.count == 1)
        #expect(result[0].items.count == 2)
        #expect(result[0].items[0].content == "new")
        #expect(result[0].items[1].content == "also new")
    }

    @Test("agent name resolves via provided closure")
    func nameProviderUsed() {
        let events = [
            makeEvent(agentId: "xyz", sequence: 1, type: "plan_update", text: "[wip] thing")
        ]
        let customProvider: (String) -> String = { id in "Display(\(id))" }
        let result = AgentPlanSnapshot.derive(events: events, agentNameFor: customProvider)
        #expect(result[0].agentName == "Display(xyz)")
    }

    @Test("session-scoped plan_update uses sender actor id for display name")
    func senderActorIDPreferredOverSessionScope() {
        let events = [
            makeEvent(
                agentId: "session-e68a8382",
                sequence: 1,
                type: "plan_update",
                text: "[wip] thing",
                senderActorID: "agent-codex"
            )
        ]
        let result = AgentPlanSnapshot.derive(events: events, agentNameFor: nameProvider)
        #expect(result.count == 1)
        #expect(result[0].agentID == "agent-codex")
        #expect(result[0].agentName == "agent-age")
    }

    @Test("plan_update with empty text → snapshot filtered out")
    func emptyText() {
        let events = [
            makeEvent(agentId: "aaa1", sequence: 1, type: "plan_update", text: nil),
            makeEvent(agentId: "bbb2", sequence: 2, type: "plan_update", text: ""),
        ]
        let result = AgentPlanSnapshot.derive(events: events, agentNameFor: nameProvider)
        #expect(result == [])
    }

    @Test("non plan_update events are ignored")
    func unrelatedEvents() {
        let events = [
            makeEvent(agentId: "aaa1", sequence: 1, type: "thinking", text: "hmm"),
            makeEvent(agentId: "aaa1", sequence: 2, type: "output", text: "reply"),
        ]
        let result = AgentPlanSnapshot.derive(events: events, agentNameFor: nameProvider)
        #expect(result == [])
    }
}
