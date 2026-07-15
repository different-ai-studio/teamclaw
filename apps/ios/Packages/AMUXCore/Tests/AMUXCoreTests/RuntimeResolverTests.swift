import Testing
import Foundation
import SwiftData
@testable import AMUXCore

@Suite("RuntimeResolver")
@MainActor
struct RuntimeResolverTests {

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([Runtime.self, Session.self, CachedAgentRuntime.self])
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: config)
    }

    @Test("nil session yields nil")
    func nilSessionYieldsNil() throws {
        let container = try makeContainer()
        let ctx = ModelContext(container)
        let resolved = RuntimeResolver.resolve(existing: nil, session: nil, modelContext: ctx)
        #expect(resolved == nil)
    }

    @Test("session without primary agent (human-only) yields nil")
    func humanOnlySessionYieldsNil() throws {
        let container = try makeContainer()
        let ctx = ModelContext(container)
        let session = Session(
            sessionId: "s-1", teamId: "team", title: "chat",
            createdBy: "actor-1", createdAt: .now, summary: "hi",
            participantCount: 1, lastMessagePreview: "hi",
            lastMessageAt: nil, ideaId: ""
        )
        // No primaryAgentId set — human-only.
        let resolved = RuntimeResolver.resolve(existing: nil, session: session, modelContext: ctx)
        #expect(resolved == nil)
    }

    @Test("existing runtime short-circuits and is returned unchanged")
    func existingShortCircuits() throws {
        let container = try makeContainer()
        let ctx = ModelContext(container)
        let existing = Runtime(runtimeId: "preset-1", agentType: 1, status: 1)
        let session = Session(
            sessionId: "s-1", teamId: "team", title: "chat",
            createdBy: "actor-1", createdAt: .now, summary: "hi",
            participantCount: 1, lastMessagePreview: "hi",
            lastMessageAt: nil, ideaId: ""
        )
        session.primaryAgentId = "agent-actor-1"
        let resolved = RuntimeResolver.resolve(existing: existing, session: session, modelContext: ctx)
        #expect(resolved?.runtimeId == "preset-1")
    }

    @Test("resolves matching Runtime row when CachedAgentRuntime has the runtimeId bridge")
    func resolvesMatchingRuntime() throws {
        let container = try makeContainer()
        let ctx = ModelContext(container)

        let runtime = Runtime(runtimeId: "rt-abc", agentType: 1, status: 1)
        ctx.insert(runtime)

        let cached = CachedAgentRuntime(
            id: "ar-1", teamId: "team", agentId: "agent-actor-1",
            sessionId: "s-1", backendType: "claude", status: "active",
            runtimeId: "rt-abc"
        )
        ctx.insert(cached)
        try ctx.save()

        let session = Session(
            sessionId: "s-1", teamId: "team", title: "chat",
            createdBy: "actor-1", createdAt: .now, summary: "hi",
            participantCount: 1, lastMessagePreview: "hi",
            lastMessageAt: nil, ideaId: ""
        )
        session.primaryAgentId = "agent-actor-1"

        let resolved = RuntimeResolver.resolve(existing: nil, session: session, modelContext: ctx)
        #expect(resolved?.runtimeId == "rt-abc")
    }

    @Test("synthesises a placeholder when no live Runtime row exists for the bridge yet")
    func placeholderWhenRuntimeNotPublished() throws {
        let container = try makeContainer()
        let ctx = ModelContext(container)

        // CachedAgentRuntime exists but no Runtime row published yet.
        let cached = CachedAgentRuntime(
            id: "ar-2", teamId: "team", agentId: "agent-actor-1",
            sessionId: "s-1", backendType: "claude", status: "starting",
            runtimeId: "rt-pending"
        )
        ctx.insert(cached)
        try ctx.save()

        let session = Session(
            sessionId: "s-1", teamId: "team", title: "Helping with refactor",
            createdBy: "actor-1", createdAt: .now, summary: "summary text",
            participantCount: 2, lastMessagePreview: "hi",
            lastMessageAt: nil, ideaId: ""
        )
        session.primaryAgentId = "agent-actor-1"

        let resolved = RuntimeResolver.resolve(existing: nil, session: session, modelContext: ctx)
        let placeholder = try #require(resolved)
        #expect(placeholder.runtimeId == "rt-pending")
        #expect(placeholder.sessionTitle == "Helping with refactor")
        #expect(placeholder.currentPrompt == "summary text")
        #expect(placeholder.agentType == 1) // claude → 1
        #expect(!placeholder.availableModelsJSON.isEmpty,
                "claude placeholder should seed default model list")
    }

    @Test("agentTypeRaw maps backend strings to daemon-aligned ints")
    func agentTypeRawMapping() {
        #expect(RuntimeResolver.agentTypeRaw(for: "claude") == 1)
        #expect(RuntimeResolver.agentTypeRaw(for: "opencode") == 2)
        #expect(RuntimeResolver.agentTypeRaw(for: "codex") == 3)
        #expect(RuntimeResolver.agentTypeRaw(for: nil) == 1,
                "nil backend type defaults to claude (1)")
        #expect(RuntimeResolver.agentTypeRaw(for: "unknown") == 1)
    }
}
