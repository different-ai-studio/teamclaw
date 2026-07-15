import Foundation

/// Pure formatter for the agent button label in `SessionComposer` Row 2.
/// Lives in AMUXCore so it can be unit-tested via `pnpm ios:test:core`.
public enum AgentButtonLabel {
    /// Nil → render icon only (no text after the @ glyph).
    /// Otherwise → render text after `@ `.
    public static func text(selectedDisplayNamesInOrder names: [String]) -> String? {
        guard let first = names.first else { return nil }
        if names.count == 1 { return first }
        return "\(first) \u{00D7}\(names.count)"
    }
}
