import Foundation

/// Reads the team-shared resources an actor detail screen reports: which skills
/// and MCP servers an actor has installed, and the team's environment keys.
///
/// Read-only on purpose. Installing is a desktop concern (it writes a local
/// lockfile alongside the server row), and MCP refuses installs on anyone
/// else's behalf outright, so a phone that could install for the agent it is
/// looking at would be lying about what it did.
public protocol TeamResourceRepository: Sendable {
    /// `actorID` selects whose install state decorates each row. Nil means the
    /// caller.
    func listSkills(teamID: String, actorID: String?) async throws -> [TeamSkillRecord]
    func listMcpServers(teamID: String, actorID: String?) async throws -> [TeamMcpServerRecord]
    /// Team-wide: there is no actor dimension on env secrets.
    func listEnvSecrets(teamID: String) async throws -> [TeamEnvSecretRecord]
}

public extension TeamResourceRepository {
    /// The three numbers together, fetched concurrently.
    ///
    /// A failing leg yields 0 for that number rather than failing the whole
    /// screen: these are decorations on a detail page that is useful without
    /// them, and one unreachable endpoint should not blank the other two.
    func counts(teamID: String, actorID: String?) async -> TeamResourceCounts {
        async let skills = try? listSkills(teamID: teamID, actorID: actorID)
        async let mcp = try? listMcpServers(teamID: teamID, actorID: actorID)
        async let env = try? listEnvSecrets(teamID: teamID)
        return TeamResourceCounts(
            skills: (await skills)?.filter(\.installed).count ?? 0,
            mcp: (await mcp)?.filter(\.installed).count ?? 0,
            env: (await env)?.count ?? 0
        )
    }
}

public actor CloudAPITeamResourceRepository: TeamResourceRepository {
    private let client: CloudAPIClient

    public init(client: CloudAPIClient) {
        self.client = client
    }

    public func listSkills(teamID: String, actorID: String?) async throws -> [TeamSkillRecord] {
        let page: CloudPage<CloudTeamSkill> = try await client.get(
            "/v1/teams/\(Self.enc(teamID))/skills\(Self.actorQuery(actorID))"
        )
        return page.items
            .map(\.record)
            .sorted { $0.slug.localizedCaseInsensitiveCompare($1.slug) == .orderedAscending }
    }

    public func listMcpServers(teamID: String, actorID: String?) async throws -> [TeamMcpServerRecord] {
        let page: CloudPage<CloudTeamMcpServer> = try await client.get(
            "/v1/teams/\(Self.enc(teamID))/mcp-servers\(Self.actorQuery(actorID))"
        )
        return page.items
            .map(\.record)
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    public func listEnvSecrets(teamID: String) async throws -> [TeamEnvSecretRecord] {
        let page: CloudPage<CloudTeamEnvSecret> = try await client.get(
            "/v1/teams/\(Self.enc(teamID))/env-secrets"
        )
        return page.items
            .map(\.record)
            .sorted { $0.keyId.localizedCaseInsensitiveCompare($1.keyId) == .orderedAscending }
    }

    private static func actorQuery(_ actorID: String?) -> String {
        guard let actorID, !actorID.isEmpty else { return "" }
        return "?actorId=\(encQuery(actorID))"
    }

    private static func enc(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private static func encQuery(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
    }
}

// MARK: - Wire shapes

private struct CloudPage<Item: Decodable & Sendable>: Decodable, Sendable {
    let items: [Item]
}

private struct CloudTeamSkill: Decodable, Sendable {
    let id: String
    let slug: String
    let summary: String?
    let category: String?
    let whenToUse: String?
    let status: String?
    let latestVersion: Int?
    let installed: Bool?
    let installedVersion: Int?
    let installScope: String?
    let hasUpdate: Bool?

    var record: TeamSkillRecord {
        TeamSkillRecord(
            id: id,
            slug: slug,
            summary: summary ?? "",
            category: category ?? "general",
            whenToUse: whenToUse ?? "",
            status: status ?? "published",
            latestVersion: latestVersion ?? 1,
            installed: installed ?? false,
            installedVersion: installedVersion,
            installScope: installScope,
            hasUpdate: hasUpdate ?? false
        )
    }
}

private struct CloudTeamMcpServer: Decodable, Sendable {
    let id: String
    let name: String
    let transport: String?
    let description: String?
    let command: String?
    let url: String?
    let installed: Bool?

    var record: TeamMcpServerRecord {
        TeamMcpServerRecord(
            id: id,
            name: name,
            transport: transport ?? "local",
            description: description,
            command: command,
            url: url,
            installed: installed ?? false
        )
    }
}

private struct CloudTeamEnvSecret: Decodable, Sendable {
    let keyId: String
    let updatedAt: String?

    // `envelope` is deliberately not decoded: it is AES-GCM ciphertext this
    // client has no key for, so pulling it in would only invite someone to try
    // to display it.
    var record: TeamEnvSecretRecord {
        TeamEnvSecretRecord(keyId: keyId, updatedAt: parseCloudDate(updatedAt))
    }
}
