import Foundation

/// Top-level tab identifiers for RootTabView. Kept in its own file so it
/// can be referenced from any tab view without pulling in RootTabView.
public enum AppTab: String, Hashable, Codable, Sendable {
    case sessions
    case ideas
    case members
    case search
}
