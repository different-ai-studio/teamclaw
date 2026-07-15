import Foundation

public enum TodoItemStatus: Sendable, Equatable {
    case pending
    case inProgress
    case completed
    case cancelled
}

public struct TodoItem: Sendable, Equatable {
    public let content: String
    public let status: TodoItemStatus

    public init(content: String, status: TodoItemStatus) {
        self.content = content
        self.status = status
    }
}

/// Parse the daemon's todo_update text payload into structured items.
/// Each non-empty line maps to one `TodoItem`. Recognized prefixes:
///   - `[done] foo`       → .completed
///   - `[wip] foo`        → .inProgress
///   - `[todo] foo`       → .pending
///   - `[cancelled] foo`  → .cancelled
/// Lines without a recognized prefix become `.pending` with the raw line
/// (trimmed) as content. Blank lines are skipped.
public func parseTodoText(_ text: String) -> [TodoItem] {
    text.split(separator: "\n", omittingEmptySubsequences: true).compactMap { rawLine in
        let line = String(rawLine).trimmingCharacters(in: .whitespaces)
        if line.isEmpty { return nil }

        if let stripped = line.stripping(prefix: "[done]") {
            return TodoItem(content: stripped, status: .completed)
        }
        if let stripped = line.stripping(prefix: "[wip]") {
            return TodoItem(content: stripped, status: .inProgress)
        }
        if let stripped = line.stripping(prefix: "[todo]") {
            return TodoItem(content: stripped, status: .pending)
        }
        if let stripped = line.stripping(prefix: "[cancelled]") {
            return TodoItem(content: stripped, status: .cancelled)
        }
        return TodoItem(content: line, status: .pending)
    }
}

private extension String {
    /// Returns the substring after `prefix`, trimmed of surrounding
    /// whitespace, or nil if `self` does not start with `prefix`.
    func stripping(prefix: String) -> String? {
        guard hasPrefix(prefix) else { return nil }
        return String(dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
    }
}
