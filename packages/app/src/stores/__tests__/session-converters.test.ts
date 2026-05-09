import { describe, expect, it } from "vitest";
import {
  convertMessage,
  convertSession,
  convertSessionListItem,
} from "@/stores/session-converters";
import type { Message as OpenCodeMessage } from "@/lib/opencode/sdk-types";

function makeOpenCodeMessage(
  overrides: Partial<OpenCodeMessage> = {},
): OpenCodeMessage {
  return {
    info: {
      id: "msg-1",
      sessionID: "sess-1",
      role: "user",
      time: { created: 1 },
    },
    parts: [],
    ...overrides,
  } as OpenCodeMessage;
}

describe("convertMessage", () => {
  it("marks OpenCode compaction user messages for dedicated rendering", () => {
    const converted = convertMessage(
      makeOpenCodeMessage({
        info: {
          id: "msg-compaction",
          sessionID: "sess-1",
          role: "user",
          agent: "build",
          time: { created: 1 },
        },
        parts: [
          {
            id: "part-compaction",
            sessionID: "sess-1",
            messageID: "msg-compaction",
            type: "compaction",
            auto: true,
            overflow: true,
          },
        ],
      } as unknown as Partial<OpenCodeMessage>),
    );

    expect(converted.content).toBe("");
    expect(converted.displayKind).toBe("compaction");
    expect(converted.compaction).toEqual({
      auto: true,
      overflow: true,
      completed: true,
    });
  });

  it("hides OpenCode compaction summary assistant messages", () => {
    const converted = convertMessage(
      makeOpenCodeMessage({
        info: {
          id: "msg-summary",
          sessionID: "sess-1",
          role: "assistant",
          parentID: "msg-compaction",
          mode: "compaction",
          agent: "compaction",
          summary: true,
          time: { created: 2, completed: 3 },
        },
        parts: [{ id: "part-text", sessionID: "sess-1", messageID: "msg-summary", type: "text", text: "summary" }],
      } as unknown as Partial<OpenCodeMessage>),
    );

    expect(converted.displayKind).toBe("compaction-summary");
    expect(converted.hidden).toBe(true);
    expect(converted.parentID).toBe("msg-compaction");
  });

  it("hides explicit synthetic compaction continue user messages", () => {
    const converted = convertMessage(
      makeOpenCodeMessage({
        info: {
          id: "msg-synthetic",
          sessionID: "sess-1",
          role: "user",
          synthetic: true,
          metadata: { compaction_continue: true },
          time: { created: 4 },
        },
        parts: [
          { id: "part-text", sessionID: "sess-1", messageID: "msg-synthetic", type: "text", text: "repeat visible user text" },
        ],
      } as unknown as Partial<OpenCodeMessage>),
    );

    expect(converted.displayKind).toBe("synthetic");
    expect(converted.hidden).toBe(true);
    expect(converted.content).toBe("");
  });

  it("keeps regular synthetic user text visible when it is not a compaction marker", () => {
    const converted = convertMessage(
      makeOpenCodeMessage({
        info: {
          id: "msg-synthetic-regular",
          sessionID: "sess-1",
          role: "user",
          synthetic: true,
          time: { created: 5 },
        },
        parts: [
          { id: "part-text", sessionID: "sess-1", messageID: "msg-synthetic-regular", type: "text", text: "regular synthetic text" },
        ],
      } as unknown as Partial<OpenCodeMessage>),
    );

    expect(converted.displayKind).toBeUndefined();
    expect(converted.hidden).toBeUndefined();
    expect(converted.content).toBe("regular synthetic text");
  });
});

describe("session converters archive metadata", () => {
  it("preserves archive metadata on full sessions", () => {
    const archivedAt = Date.parse("2026-05-06T09:30:00.000Z");

    const converted = convertSession({
      id: "ses_archived",
      title: "Archived chat",
      directory: "/workspace",
      time: {
        created: archivedAt - 2000,
        updated: archivedAt - 1000,
        archived: archivedAt,
      },
    } as never);

    expect(converted.isArchived).toBe(true);
    expect(converted.archivedAt?.toISOString()).toBe("2026-05-06T09:30:00.000Z");
  });

  it("preserves archive metadata on session list items", () => {
    const archivedAt = Date.parse("2026-05-06T09:31:00.000Z");

    const converted = convertSessionListItem({
      id: "ses_archived_list",
      title: "Archived list chat",
      directory: "/workspace",
      time: {
        created: archivedAt - 2000,
        updated: archivedAt - 1000,
        archived: archivedAt,
      },
    } as never);

    expect(converted.isArchived).toBe(true);
    expect(converted.archivedAt?.toISOString()).toBe("2026-05-06T09:31:00.000Z");
  });

  it("leaves active sessions unmarked", () => {
    const now = Date.parse("2026-05-06T09:32:00.000Z");

    const converted = convertSessionListItem({
      id: "ses_active",
      title: "Active chat",
      directory: "/workspace",
      time: { created: now - 1000, updated: now },
    } as never);

    expect(converted.isArchived).toBeUndefined();
    expect(converted.archivedAt).toBeUndefined();
  });

  it("preserves archive metadata when archived timestamp is zero", () => {
    const converted = convertSessionListItem({
      id: "ses_archived_epoch",
      title: "Archived at epoch",
      directory: "/workspace",
      time: { created: 0, updated: 0, archived: 0 },
    } as never);

    expect(converted.isArchived).toBe(true);
    expect(converted.archivedAt?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });

  it("leaves null archived sessions unmarked", () => {
    const now = Date.parse("2026-05-06T09:33:00.000Z");

    const converted = convertSessionListItem({
      id: "ses_restored",
      title: "Restored chat",
      directory: "/workspace",
      time: { created: now - 1000, updated: now, archived: null },
    } as never);

    expect(converted.isArchived).toBeUndefined();
    expect(converted.archivedAt).toBeUndefined();
  });
});
