import { describe, expect, it } from "vitest";
import {
  countUnboundCallingTasks,
  resolveOrphanSubagentParentToolId,
  shouldBufferUnboundChildAcpEvent,
  shouldRouteOrphanSubagentEvent,
} from "@/lib/teamclaw/subagent-acp-routing";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";

const baseEntry = (toolCalls: AgentStreamEntry["toolCalls"]): AgentStreamEntry => ({
  sessionId: "sess-1",
  actorId: "agent-1",
  outputText: "",
  thinkingText: "",
  parts: [],
  toolCalls,
  planEntries: [],
  pendingPermissionsByRequestId: {},
  errorMessage: null,
  errorDetails: null,
  lastUpdate: 0,
  active: true,
  streamId: "s1",
});

const taskCall = (id: string) => ({
  id,
  name: "Run markets scan",
  status: "calling" as const,
  arguments: { subagent_type: "general", prompt: id },
  startTime: new Date(),
});

describe("subagent acp routing", () => {
  it("does not buffer when child sid is already bound", () => {
    const slice = {
      byKey: { "sess-1::agent-1": baseEntry([taskCall("task-1")]) },
      childAcpSessionToToolId: { ses_child: "task-1" },
      pendingSubagentEvents: {},
    };
    expect(
      shouldBufferUnboundChildAcpEvent("sess-1", "agent-1", "ses_child", slice),
    ).toBe(false);
  });

  it("buffers unbound child sid regardless of other bound tasks", () => {
    const slice = {
      byKey: {
        "sess-1::agent-1": baseEntry([
          taskCall("task-us"),
          taskCall("task-eu"),
        ]),
      },
      childAcpSessionToToolId: { ses_child_us: "task-us" },
      pendingSubagentEvents: {},
    };
    expect(countUnboundCallingTasks("sess-1", "agent-1", slice)).toBe(1);
    expect(
      shouldBufferUnboundChildAcpEvent("sess-1", "agent-1", "ses_child_eu", slice),
    ).toBe(true);
  });

  it("disables orphan when multiple unbound calling tasks", () => {
    const slice = {
      byKey: {
        "sess-1::agent-1": baseEntry([
          taskCall("task-a"),
          taskCall("task-b"),
        ]),
      },
      childAcpSessionToToolId: {},
      pendingSubagentEvents: {},
    };
    expect(resolveOrphanSubagentParentToolId("sess-1", "agent-1", slice)).toBeUndefined();
    expect(
      shouldRouteOrphanSubagentEvent(
        { event: { case: "thinking", value: { text: "scan" } }, model: "" },
        "task-a",
      ),
    ).toBe(true);
  });

  it("enables orphan for single unbound calling task", () => {
    const slice = {
      byKey: {
        "sess-1::agent-1": baseEntry([
          { ...taskCall("task-1"), status: "completed" },
          taskCall("task-2"),
        ]),
      },
      childAcpSessionToToolId: { ses_child_1: "task-1" },
      pendingSubagentEvents: {},
    };
    expect(resolveOrphanSubagentParentToolId("sess-1", "agent-1", slice)).toBe("task-2");
  });

  it("does not orphan parent output", () => {
    expect(
      shouldRouteOrphanSubagentEvent(
        { event: { case: "output", value: { text: "summary" } }, model: "" },
        "task-1",
      ),
    ).toBe(false);
  });

  it("routes orphan thinking to active task while calling", () => {
    expect(
      shouldRouteOrphanSubagentEvent(
        {
          event: { case: "thinking", value: { text: "run ps" } },
          model: "",
        },
        "task-1",
      ),
    ).toBe(true);
    expect(
      shouldRouteOrphanSubagentEvent(
        {
          event: {
            case: "toolUse",
            value: {
              toolId: "bash-1",
              toolName: "bash",
              description: "",
              params: {},
            },
          },
          model: "",
        },
        "task-1",
      ),
    ).toBe(true);
  });
});
