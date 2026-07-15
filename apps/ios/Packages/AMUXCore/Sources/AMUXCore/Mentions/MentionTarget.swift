import Foundation

public extension MentionTarget {
    enum Kind: Sendable, Equatable, Hashable {
        case member
        case agent
    }
}

/// Lightweight handle for an actor that can be `@`-mentioned in the
/// composer. Carries display name (used both as the matching needle and
/// the rendered token) and the underlying actor id (so the caller can
/// either insert it inline or toggle a routing chip).
public struct MentionTarget: Identifiable, Equatable, Hashable, Sendable {
    public let id: String          // actor id
    public let displayName: String
    public let subtitle: String?   // e.g. "Member", "Claude · idle"
    public let kind: Kind

    public init(id: String,
                displayName: String,
                subtitle: String? = nil,
                kind: Kind = .member) {
        self.id = id
        self.displayName = displayName
        self.subtitle = subtitle
        self.kind = kind
    }
}

#if DEBUG
public extension MentionTarget {
    /// Convenience factory for unit tests.
    static func testFixture(
        actorID: String,
        kind: Kind,
        displayName: String,
        subtitle: String? = nil
    ) -> MentionTarget {
        MentionTarget(id: actorID, displayName: displayName, subtitle: subtitle, kind: kind)
    }
}
#endif
