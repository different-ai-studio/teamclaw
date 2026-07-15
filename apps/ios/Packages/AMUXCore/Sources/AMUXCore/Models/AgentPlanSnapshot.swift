import Foundation

/// One agent's latest plan_update parsed into structured items. The view
/// model exposes a `[AgentPlanSnapshot]` filtered to entries that still
/// have at least one pending or in-progress item so the UI can drive
/// both the toolbar icon's visibility and the swipeable Plans panel
/// pages from a single source.
public struct AgentPlanSnapshot: Identifiable, Equatable, Sendable {
    public let agentID: String
    public let agentName: String
    public let text: String
    public let items: [TodoItem]

    public var id: String { agentID }

    public var hasUnfinished: Bool {
        items.contains { $0.status == .pending || $0.status == .inProgress }
    }

    public init(agentID: String, agentName: String, text: String, items: [TodoItem]) {
        self.agentID = agentID
        self.agentName = agentName
        self.text = text
        self.items = items
    }

    /// Walk `events` and produce one snapshot per agent that still has
    /// unfinished items in its most recent plan_update. Page order is
    /// determined by the agent's first plan_update appearance in the
    /// stream so the panel's swipe order stays stable as new updates
    /// arrive for the same agents.
    public static func derive(
        events: [AgentEvent],
        agentNameFor: (String) -> String
    ) -> [AgentPlanSnapshot] {
        var latestByAgent: [String: AgentEvent] = [:]
        var firstSeen: [String: Int] = [:]
        for (idx, event) in events.enumerated() where event.eventType == "plan_update" {
            let agentID = event.planAgentID
            latestByAgent[agentID] = event
            if firstSeen[agentID] == nil {
                firstSeen[agentID] = idx
            }
        }
        let ordered = latestByAgent.keys.sorted { lhs, rhs in
            (firstSeen[lhs] ?? Int.max) < (firstSeen[rhs] ?? Int.max)
        }
        return ordered.compactMap { agentID -> AgentPlanSnapshot? in
            guard let event = latestByAgent[agentID],
                  let text = event.text, !text.isEmpty else { return nil }
            let items = parseTodoText(text)
            let snapshot = AgentPlanSnapshot(
                agentID: agentID,
                agentName: agentNameFor(agentID),
                text: text,
                items: items
            )
            return snapshot.hasUnfinished ? snapshot : nil
        }
    }
}

private extension AgentEvent {
    var planAgentID: String {
        if let senderActorID, !senderActorID.isEmpty {
            return senderActorID
        }
        return agentId
    }
}
