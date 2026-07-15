import Foundation

public enum GroupedEvent: Identifiable {
    case single(AgentEvent)
    case toolRun(id: String, events: [AgentEvent])

    public var id: String {
        switch self {
        case .single(let e): e.id
        case .toolRun(let id, _): id
        }
    }
}

/// Groups completed tool_use events into tool runs, skipping over
/// thinking and tool_result events that naturally occur between tools.
/// A tool run breaks at user_prompt, output, error, permission_request, or plan_update.
/// Running/incomplete tools also break the run.
public func groupEvents(_ events: [AgentEvent]) -> [GroupedEvent] {
    let skippableTypes: Set<String> = ["thinking", "tool_result"]

    var result: [GroupedEvent] = []
    var i = 0
    while i < events.count {
        let event = events[i]

        if event.eventType == "tool_use", event.isComplete {
            var toolEvents: [AgentEvent] = [event]
            var skippedEvents: [AgentEvent] = []
            var j = i + 1

            while j < events.count {
                let next = events[j]
                if next.eventType == "tool_use", next.isComplete {
                    skippedEvents.removeAll()
                    toolEvents.append(next)
                    j += 1
                } else if skippableTypes.contains(next.eventType) {
                    skippedEvents.append(next)
                    j += 1
                } else {
                    break
                }
            }

            if toolEvents.count >= 3 {
                let groupId = "toolrun-\(toolEvents.first!.id)"
                result.append(.toolRun(id: groupId, events: toolEvents))
            } else {
                for e in toolEvents { result.append(.single(e)) }
            }
            for e in skippedEvents { result.append(.single(e)) }
            i = j
        } else {
            result.append(.single(event))
            i += 1
        }
    }
    return result
}
