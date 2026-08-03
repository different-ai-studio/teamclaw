import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";

import {
  ActorPresenceSchema,
  LiveSessionSchema,
  ModelInfoSchema,
  WorktreeCatalogSchema,
} from "@/lib/proto/amux_pb";
import { parseActorStateTopic, projectActorPresence } from "@/stores/runtime-state-store";

function presence(overrides: Parameters<typeof create<typeof ActorPresenceSchema>>[1] = {}) {
  return create(ActorPresenceSchema, {
    online: true,
    displayName: "MACPRO",
    catalogModels: [
      create(ModelInfoSchema, { id: "opencode/a", displayName: "A" }),
      create(ModelInfoSchema, { id: "opencode/b", displayName: "B" }),
    ],
    worktrees: [
      create(WorktreeCatalogSchema, {
        worktree: "/w/one",
        modelIndices: [0, 1],
        defaultModel: "opencode/b",
      }),
    ],
    ...overrides,
  });
}

describe("parseActorStateTopic", () => {
  it("matches the actor state topic and not the per-runtime one", () => {
    expect(parseActorStateTopic("amux/team-1/actor-1/state")).toEqual({
      teamId: "team-1",
      actorId: "actor-1",
    });
    expect(parseActorStateTopic("amux/team-1/actor-1/runtime/rt-1/state")).toBeNull();
  });
});

describe("projectActorPresence", () => {
  it("keys entries by session id, resolving the catalog by index", () => {
    const updates = projectActorPresence(
      "actor-1",
      presence({
        liveSessions: [
          create(LiveSessionSchema, { sessionId: "session-1", currentModel: "opencode/a" }),
        ],
      }),
    );

    expect(updates).toHaveLength(1);
    // Keyed by session, not by a spawn id: a spawn id is stale the moment it is
    // recorded, whereas one attachment serves a session at a time (ADR-0004).
    expect(updates[0]!.runtimeId).toBe("session-1");
    expect(updates[0]!.daemonActorId).toBe("actor-1");
    expect(updates[0]!.info.availableModels.map((m) => m.id)).toEqual([
      "opencode/a",
      "opencode/b",
    ]);
    expect(updates[0]!.info.currentModel).toBe("opencode/a");
  });

  it("falls back to the worktree's default model when the session has none", () => {
    const updates = projectActorPresence(
      "actor-1",
      presence({ liveSessions: [create(LiveSessionSchema, { sessionId: "session-2" })] }),
    );
    expect(updates[0]!.info.currentModel).toBe("opencode/b");
  });

  it("emits nothing for an actor holding no attachments", () => {
    // Absence is the signal for "cold" — there is no stopped entry to publish.
    expect(projectActorPresence("actor-1", presence({ liveSessions: [] }))).toEqual([]);
  });
});
