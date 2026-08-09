import Foundation

/// The three team-shared resource kinds an actor detail screen reports on.
///
/// They do **not** share a scope, and the difference is load-bearing for any UI
/// that shows them side by side:
///
/// - `skills` are genuinely per-actor. `team_skill_installs.actor_id` covers
///   both a member installing for themselves and an admin installing for a team
///   agent; for a team agent that row is the authority (ADR in
///   `20260806000000_team_skills_registry.sql`).
/// - `mcp` is per-actor to *read* and self-only to *write*. You can see what an
///   agent has installed; you cannot install on its behalf.
/// - `env` has no actor dimension at all. `team_env_secrets` is keyed
///   `(team, keyId)`, so every actor in a team reports the same number.
public enum TeamResourceKind: String, Sendable, CaseIterable {
    case skills
    case mcp
    case env

    /// Whether the count varies per actor. `env` does not, so a UI showing it
    /// on an actor's page has to say whose it is.
    public var isActorScoped: Bool {
        switch self {
        case .skills, .mcp: true
        case .env: false
        }
    }
}

// MARK: - Skills

public struct TeamSkillRecord: Identifiable, Equatable, Sendable {
    public let id: String
    public let slug: String
    public let summary: String
    public let category: String
    /// The field that lets two similar skills be told apart at a glance.
    public let whenToUse: String
    public let status: String
    public let latestVersion: Int
    /// Whether the subject actor — not necessarily the caller — has it.
    public let installed: Bool
    public let installedVersion: Int?
    /// `global` | `workspace`, or nil when not installed.
    public let installScope: String?
    public let hasUpdate: Bool

    public init(id: String, slug: String, summary: String, category: String,
                whenToUse: String, status: String, latestVersion: Int,
                installed: Bool, installedVersion: Int?, installScope: String?,
                hasUpdate: Bool) {
        self.id = id
        self.slug = slug
        self.summary = summary
        self.category = category
        self.whenToUse = whenToUse
        self.status = status
        self.latestVersion = latestVersion
        self.installed = installed
        self.installedVersion = installedVersion
        self.installScope = installScope
        self.hasUpdate = hasUpdate
    }
}

// MARK: - MCP

public struct TeamMcpServerRecord: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    /// `local` | `remote`.
    public let transport: String
    public let description: String?
    /// For `local`: the command it runs. For `remote`: nil.
    public let command: String?
    /// For `remote`: the endpoint. For `local`: nil.
    public let url: String?
    /// Whether the subject actor has installed it.
    public let installed: Bool

    public init(id: String, name: String, transport: String, description: String?,
                command: String?, url: String?, installed: Bool) {
        self.id = id
        self.name = name
        self.transport = transport
        self.description = description
        self.command = command
        self.url = url
        self.installed = installed
    }
}

// MARK: - Env

/// A team environment variable, **name only**.
///
/// The value never leaves the server in the clear: it is an AES-GCM envelope
/// the client would need the team key to open. iOS has no such key, so a list
/// here can show which variables exist and when they changed, never what they
/// hold. A detail screen must not imply otherwise.
public struct TeamEnvSecretRecord: Identifiable, Equatable, Sendable {
    public var id: String { keyId }
    public let keyId: String
    public let updatedAt: Date?

    public init(keyId: String, updatedAt: Date?) {
        self.keyId = keyId
        self.updatedAt = updatedAt
    }
}

// MARK: - Counts

/// The three numbers an actor detail screen shows. `env` is team-wide; the
/// other two belong to the actor that was asked about.
public struct TeamResourceCounts: Equatable, Sendable {
    public let skills: Int
    public let mcp: Int
    public let env: Int

    public static let zero = TeamResourceCounts(skills: 0, mcp: 0, env: 0)

    public init(skills: Int, mcp: Int, env: Int) {
        self.skills = skills
        self.mcp = mcp
        self.env = env
    }

    public func value(for kind: TeamResourceKind) -> Int {
        switch kind {
        case .skills: skills
        case .mcp: mcp
        case .env: env
        }
    }
}
