import Testing
import Foundation
import SwiftData
@testable import AMUXCore

@Suite("RuntimeResolver")
@MainActor
struct RuntimeResolverTests {

    private func makeContainer() throws -> ModelContainer {
        let schema = Schema([Runtime.self, Session.self])
        let config = ModelConfiguration(isStoredInMemoryOnly: true)
        return try ModelContainer(for: schema, configurations: config)
    }

    private func makeSession(id: String, primaryAgent: String?) -> Session {
        let s = Session(
            sessionId: id, teamId: "team", title: "chat",
            createdBy: "actor-1", createdAt: .now, summary: "hi",
            participantCount: 1, lastMessagePreview: "hi",
            lastMessageAt: nil, ideaId: ""
        )
        s.primaryAgentId = primaryAgent
        return s
    }

    @Test("nil session yields nil")
    func nilSessionYieldsNil() throws {
        let ctx = ModelContext(try makeContainer())
        #expect(RuntimeResolver.resolve(existing: nil, session: nil, modelContext: ctx) == nil)
    }

    @Test("human-only session yields nil rather than a placeholder")
    func humanOnlySessionYieldsNil() throws {
        // A placeholder here would make downstream paths like
        // requestTurnHistory surface "Runtime id missing" for chats that
        // legitimately have no agent to talk to.
        let ctx = ModelContext(try makeContainer())
        let session = makeSession(id: "s-1", primaryAgent: nil)
        ctx.insert(session)
        #expect(RuntimeResolver.resolve(existing: nil, session: session, modelContext: ctx) == nil)
    }

    @Test("existing runtime short-circuits and is returned unchanged")
    func existingShortCircuits() throws {
        let ctx = ModelContext(try makeContainer())
        let existing = Runtime(runtimeId: "already-bound", agentType: 2, status: 2)
        let session = makeSession(id: "s-1", primaryAgent: "agent-1")
        ctx.insert(session)
        let resolved = RuntimeResolver.resolve(
            existing: existing, session: session, modelContext: ctx
        )
        #expect(resolved?.runtimeId == "already-bound")
    }

    @Test("resolves the live row by session, with no bridge id involved")
    func resolvesBySessionID() throws {
        // Rows are keyed (actor, session). The old path went through
        // `CachedAgentRuntime.runtimeId` — a per-spawn id that went stale the
        // moment it was recorded (docs/debug/interrupt-agent-stale-runtime.md).
        let ctx = ModelContext(try makeContainer())
        ctx.insert(Runtime(runtimeId: "actor-a::s-1", agentType: 2, status: 2))
        let session = makeSession(id: "s-1", primaryAgent: "agent-1")
        ctx.insert(session)

        let resolved = RuntimeResolver.resolve(existing: nil, session: session, modelContext: ctx)
        #expect(resolved?.runtimeId == "actor-a::s-1")
        #expect(resolved?.status == 2)
    }

    @Test("does not confuse two actors serving the same session")
    func multipleActorsOneSession() throws {
        // A daemon holds at most one attachment per session, but a session whose
        // agents live on two machines has one per machine — and this store
        // merges every actor's retain. Keying by session alone let the second
        // actor's row evict the first.
        let ctx = ModelContext(try makeContainer())
        let older = Runtime(runtimeId: "actor-a::s-1", agentType: 2, status: 2)
        older.lastEventTime = Date(timeIntervalSince1970: 100)
        let newer = Runtime(runtimeId: "actor-b::s-1", agentType: 2, status: 2)
        newer.lastEventTime = Date(timeIntervalSince1970: 200)
        ctx.insert(older)
        ctx.insert(newer)
        let session = makeSession(id: "s-1", primaryAgent: "agent-1")
        ctx.insert(session)

        // Both survive; the resolver picks the most recently active.
        let stored = (try? ctx.fetch(FetchDescriptor<Runtime>())) ?? []
        #expect(stored.count == 2)
        let resolved = RuntimeResolver.resolve(existing: nil, session: session, modelContext: ctx)
        #expect(resolved?.runtimeId == "actor-b::s-1")
    }

    @Test("synthesises a transient placeholder when the session is cold")
    func placeholderWhenCold() throws {
        let ctx = ModelContext(try makeContainer())
        let session = makeSession(id: "s-cold", primaryAgent: "agent-1")
        ctx.insert(session)

        let resolved = RuntimeResolver.resolve(existing: nil, session: session, modelContext: ctx)
        #expect(resolved?.runtimeId == "s-cold")
        #expect(resolved?.sessionTitle == "chat")
        // Advertising no models keeps the picker hidden until the retain lands
        // with the backend's real catalog — mirroring the daemon, which no
        // longer synthesizes a default list either.
        #expect(resolved?.availableModelsJSON == "")

        // Transient: the placeholder is a view-model value, never persisted.
        let stored = (try? ctx.fetch(FetchDescriptor<Runtime>())) ?? []
        #expect(stored.isEmpty)
    }
}
