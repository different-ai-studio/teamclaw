import Foundation

/// One ACP permission option (`AcpPermissionOption`) in UI shape. The kind
/// strings come off the wire (`allow_once | allow_always | reject_once |
/// reject_always`); renderers must tolerate unknown values and treat them
/// as an allow variant so a future kind never becomes an unclickable card.
public struct PermissionOptionItem: Identifiable, Equatable, Sendable {
    /// ACP optionId — the value a grant sends back.
    public let id: String
    public let kind: String
    public let name: String

    public init(id: String, kind: String, name: String) {
        self.id = id
        self.kind = kind
        self.name = name
    }

    public var isReject: Bool { kind.hasPrefix("reject") }
    public var isAllowAlways: Bool { kind == "allow_always" }

    /// OpenCode's ACP agent defaults — used when the daemon sent no explicit
    /// options, mirroring the desktop client's fallback
    /// (packages/app/src/lib/teamclu/acp-permission-option.ts).
    public static let openCodeDefaults: [PermissionOptionItem] = [
        PermissionOptionItem(id: "once", kind: "allow_once", name: String(localized: "Allow once")),
        PermissionOptionItem(id: "always", kind: "allow_always", name: String(localized: "Always allow")),
        PermissionOptionItem(id: "reject", kind: "reject_once", name: String(localized: "Reject")),
    ]

    /// The option an auto-approve (session full access) picks: allow-once,
    /// never allow-always — flipping the agent's permanent state is a human
    /// decision. Returns nil when the request offers no once-scoped allow
    /// (e.g. only allow_always + reject): the caller must leave the banner
    /// for a human instead of auto-granting a permanent whitelist.
    public static func allowOnceOption(from options: [PermissionOptionItem]) -> PermissionOptionItem? {
        options.first(where: { $0.kind == "allow_once" })
            ?? options.first(where: { !$0.isReject && !$0.isAllowAlways })
    }
}
