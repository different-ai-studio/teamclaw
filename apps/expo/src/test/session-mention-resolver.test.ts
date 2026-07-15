import { describe, expect, it } from "vitest";

import type { Actor } from "../features/actors/actor-types";
import type { SessionSummary } from "../features/sessions/session-types";

const session: SessionSummary = {
  sessionId: "session-1",
  teamId: "team-1",
  title: "Session",
  summary: "",
  participantCount: 2,
  participantActorIds: ["member-1", "agent-1"],
  lastMessagePreview: "",
  lastMessageAt: "",
  createdAt: "",
  createdBy: "member-1",
};

function actor(actorId: string, actorType: Actor["actorType"], displayName: string): Actor {
  return {
    actorId,
    actorType,
    avatarUrl: null,
    displayName,
    agentTypes: actorType === "agent" ? ["codex"] : [],
    defaultAgentType: actorType === "agent" ? "codex" : null,
    agentKind: actorType === "agent" ? "codex" : null,
    lastActiveAt: null,
    role: null,
    teamId: "team-1",
  };
}

describe("resolveMentionActorIdsForComposer", () => {
  it("auto-mentions the sole agent participant when the composer has no explicit mention", async () => {
    const { resolveMentionActorIdsForComposer } = await import(
      "../features/sessions/session-mention-resolver"
    );

    expect(
      resolveMentionActorIdsForComposer({
        content: "hello",
        session,
        teamActors: [actor("member-1", "member", "You"), actor("agent-1", "agent", "Codex")],
      }),
    ).toEqual(["agent-1"]);
  });

  it("uses explicit @displayName mentions when multiple agents participate", async () => {
    const { resolveMentionActorIdsForComposer } = await import(
      "../features/sessions/session-mention-resolver"
    );

    expect(
      resolveMentionActorIdsForComposer({
        content: "hi @OpenCode",
        session: {
          ...session,
          participantActorIds: ["member-1", "agent-1", "agent-2"],
        },
        teamActors: [
          actor("member-1", "member", "You"),
          actor("agent-1", "agent", "Codex"),
          actor("agent-2", "agent", "OpenCode"),
        ],
      }),
    ).toEqual(["agent-2"]);
  });

  it("returns no implicit mention when multiple agents participate and none is named", async () => {
    const { resolveMentionActorIdsForComposer } = await import(
      "../features/sessions/session-mention-resolver"
    );

    expect(
      resolveMentionActorIdsForComposer({
        content: "hello everyone",
        session: {
          ...session,
          participantActorIds: ["member-1", "agent-1", "agent-2"],
        },
        teamActors: [
          actor("member-1", "member", "You"),
          actor("agent-1", "agent", "Codex"),
          actor("agent-2", "agent", "OpenCode"),
        ],
      }),
    ).toEqual([]);
  });
});

describe("resolveInitialMessageMentionActorIds", () => {
  it("mentions selected agent collaborators on the first new-session message", async () => {
    const { resolveInitialMessageMentionActorIds } = await import(
      "../features/sessions/session-mention-resolver"
    );

    expect(
      resolveInitialMessageMentionActorIds({
        collaboratorActorIds: ["member-1", "agent-1", "agent-2", "agent-1"],
        teamActors: [
          actor("member-1", "member", "Alice"),
          actor("agent-1", "agent", "Codex"),
          actor("agent-2", "agent", "OpenCode"),
        ],
      }),
    ).toEqual(["agent-1", "agent-2"]);
  });
});
