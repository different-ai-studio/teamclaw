import Foundation

public enum MentionCandidateFilter {
    /// Return mention candidates matching `query`, with agents already in
    /// `selectedAgentIDs` removed. Humans (`.member`) are always eligible.
    public static func filter(
        all: [MentionTarget],
        query: String,
        selectedAgentIDs: Set<String>
    ) -> [MentionTarget] {
        let lower = query.lowercased()
        return all.filter { target in
            let matches = lower.isEmpty
                || target.displayName.lowercased().contains(lower)
            guard matches else { return false }
            switch target.kind {
            case .member: return true
            case .agent:  return !selectedAgentIDs.contains(target.id)
            }
        }
    }
}
