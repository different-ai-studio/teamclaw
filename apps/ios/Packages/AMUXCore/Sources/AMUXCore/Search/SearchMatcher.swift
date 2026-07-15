import Foundation

/// Pure matching helpers for the global Search tab. No state, no I/O.
public enum SearchMatcher {
    /// True if `haystack` contains `query` ignoring case and diacritics.
    /// An empty or whitespace-only query returns `false` — callers should
    /// decide what empty means (usually: show a prompt, not "all results").
    public static func matches(haystack: String, query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return false }
        return haystack.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil
    }

    /// True if any non-empty field matches the query.
    public static func matchesAny(fields: [String], query: String) -> Bool {
        fields.contains { matches(haystack: $0, query: query) }
    }
}
