import Testing
@testable import AMUXCore

/// A stub whose three legs can fail independently, which is the case the
/// default `counts` implementation exists to handle.
private struct StubRepo: TeamResourceRepository {
    var skills: [TeamSkillRecord] = []
    var mcp: [TeamMcpServerRecord] = []
    var env: [TeamEnvSecretRecord] = []
    var failSkills = false
    var failMcp = false
    var failEnv = false

    struct Boom: Error {}

    func listSkills(teamID: String, actorID: String?) async throws -> [TeamSkillRecord] {
        if failSkills { throw Boom() }
        return skills
    }

    func listMcpServers(teamID: String, actorID: String?) async throws -> [TeamMcpServerRecord] {
        if failMcp { throw Boom() }
        return mcp
    }

    func listEnvSecrets(teamID: String) async throws -> [TeamEnvSecretRecord] {
        if failEnv { throw Boom() }
        return env
    }
}

private func skill(_ slug: String, installed: Bool) -> TeamSkillRecord {
    TeamSkillRecord(id: slug, slug: slug, summary: "", category: "general",
                    whenToUse: "", status: "published", latestVersion: 1,
                    installed: installed, installedVersion: installed ? 1 : nil,
                    installScope: installed ? "global" : nil, hasUpdate: false)
}

private func server(_ name: String, installed: Bool) -> TeamMcpServerRecord {
    TeamMcpServerRecord(id: name, name: name, transport: "local", description: nil,
                        command: "npx", url: nil, installed: installed)
}

@Suite("Team resource counts")
struct TeamResourceCountsTests {

    @Test("skills and mcp count installs, not the catalog")
    func countsInstallsOnly() async {
        // The list endpoints return the whole team catalog and decorate each row
        // with the subject actor's install state. Counting rows instead of
        // installs would show every actor the same number.
        let repo = StubRepo(
            skills: [skill("a", installed: true), skill("b", installed: false)],
            mcp: [server("x", installed: true), server("y", installed: false),
                  server("z", installed: true)],
            env: [TeamEnvSecretRecord(keyId: "API_KEY", updatedAt: nil)]
        )
        let counts = await repo.counts(teamID: "t", actorID: "agent-1")
        #expect(counts.skills == 1)
        #expect(counts.mcp == 2)
        #expect(counts.env == 1)
    }

    @Test("one failing leg zeroes only itself")
    func partialFailureDoesNotBlankTheScreen() async {
        let repo = StubRepo(
            skills: [skill("a", installed: true)],
            env: [TeamEnvSecretRecord(keyId: "K", updatedAt: nil)],
            failMcp: true
        )
        let counts = await repo.counts(teamID: "t", actorID: nil)
        #expect(counts.mcp == 0)
        #expect(counts.skills == 1, "a broken MCP endpoint must not blank skills")
        #expect(counts.env == 1)
    }

    @Test("env is not actor-scoped")
    func envIsTeamWide() {
        // Encoded as a property so a future change that starts passing an actor
        // id to env has to confront this rather than silently mislead.
        #expect(TeamResourceKind.env.isActorScoped == false)
        #expect(TeamResourceKind.skills.isActorScoped)
        #expect(TeamResourceKind.mcp.isActorScoped)
    }
}
