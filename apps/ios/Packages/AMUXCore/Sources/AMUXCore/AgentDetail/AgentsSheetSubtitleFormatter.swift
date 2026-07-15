import Foundation

/// Pure formatter for the subtitle line shown in `AgentsSheet`.
/// Lives in AMUXCore so it can be unit-tested via `pnpm ios:test:core`.
public enum AgentsSheetSubtitleFormatter {
    /// Returns a string like "2 selected · 5 total".
    /// The middle dot is U+00B7.
    public static func string(selected: Int, total: Int) -> String {
        "\(selected) selected · \(total) total"
    }
}
