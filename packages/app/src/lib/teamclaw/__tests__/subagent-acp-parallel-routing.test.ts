import { beforeEach, describe, expect, it } from "vitest";
import type { AcpEvent } from "@/lib/proto/amux_pb";
import { bindTaskChild, tryBindChildFromPermission } from "@/lib/teamclaw/subagent-acp-binding";
import {
  resolveOrphanSubagentParentToolId,
  shouldRouteOrphanSubagentEvent,
} from "@/lib/teamclaw/subagent-acp-routing";
import { routeSubagentAcpEvent } from "@/lib/teamclaw/subagent-acp-route";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";

const SID = "sess-1";
const ACTOR = "agent-1";

const TASKS = [
  { parentToolId: "task-us", childSid: "ses_child_us", tag: "US" },
  { parentToolId: "task-eu", childSid: "ses_child_eu", tag: "EU" },
  { parentToolId: "task-asia", childSid: "ses_child_asia", tag: "Asia" },
  { parentToolId: "task-comm", childSid: "ses_child_comm", tag: "Commodities" },
] as const;

function acpThinking(text: string): AcpEvent {
  return { event: { case: "thinking", value: { text } }, model: "" };
}

function acpOutput(text: string): AcpEvent {
  return { event: { case: "output", value: { text } }, model: "" };
}

function dispatchAcp(acpSessionId: string, acpEvent: AcpEvent): void {
  const acpSid = acpSessionId.trim();
  const store = useV2StreamingStore.getState();
  if (acpSid) {
    const parentToolId = store.childAcpSessionToToolId[acpSid];
    if (parentToolId) {
      routeSubagentAcpEvent(SID, ACTOR, parentToolId, acpEvent);
      return;
    }
    store.bufferPendingSubagentEvent(acpSid, acpEvent);
    return;
  }
  const orphanTaskToolId = resolveOrphanSubagentParentToolId(SID, ACTOR, store);
  if (
    orphanTaskToolId &&
    shouldRouteOrphanSubagentEvent(acpEvent, orphanTaskToolId)
  ) {
    routeSubagentAcpEvent(SID, ACTOR, orphanTaskToolId, acpEvent);
    return;
  }
  if (acpEvent.event?.case === "output") {
    store.appendOutput(
      SID,
      ACTOR,
      (acpEvent.event.value as { text?: string }).text ?? "",
    );
  }
}

function pushTaskInProgress(
  parentToolId: string,
  childSid: string,
  title: string,
): void {
  useV2StreamingStore.getState().pushToolUse(SID, ACTOR, {
    toolId: parentToolId,
    toolName: title,
    description: title,
    params: { subagent_type: "general", prompt: title },
    toolKind: "other",
    rawOutput: {
      metadata: { sessionId: childSid, parentSessionId: "ses_root" },
    },
  });
}

describe("parallel four tasks routing", () => {
  beforeEach(() => {
    useV2StreamingStore.setState({
      byKey: {},
      revisionBySession: {},
      archived: [],
      persistedPlansBySession: {},
      subagentByToolId: {},
      archivedSubagentByToolId: {},
      childAcpSessionToToolId: {},
      pendingSubagentEvents: {},
    });
    useV2StreamingStore.getState().pushToolUse(SID, ACTOR, {
      toolId: TASKS[0].parentToolId,
      toolName: "US markets",
      description: "US",
      params: { subagent_type: "general", prompt: "US" },
      toolKind: "other",
    });
    useV2StreamingStore.getState().pushToolUse(SID, ACTOR, {
      toolId: TASKS[1].parentToolId,
      toolName: "EU markets",
      description: "EU",
      params: { subagent_type: "general", prompt: "EU" },
      toolKind: "other",
    });
    useV2StreamingStore.getState().pushToolUse(SID, ACTOR, {
      toolId: TASKS[2].parentToolId,
      toolName: "Asia markets",
      description: "Asia",
      params: { subagent_type: "general", prompt: "Asia" },
      toolKind: "other",
    });
    useV2StreamingStore.getState().pushToolUse(SID, ACTOR, {
      toolId: TASKS[3].parentToolId,
      toolName: "Commodities",
      description: "Commodities",
      params: { subagent_type: "general", prompt: "Commodities" },
      toolKind: "other",
    });
  });

  it("routes each child stream to the matching task card", () => {
    for (const { parentToolId, childSid, tag } of TASKS) {
      dispatchAcp(childSid, acpThinking(`${tag} scan`));
      pushTaskInProgress(parentToolId, childSid, `${tag} markets`);
    }

    const store = useV2StreamingStore.getState();
    for (const { parentToolId, tag } of TASKS) {
      const sub = store.subagentByToolId[parentToolId];
      expect(sub?.parts.some((p) => p.type === "reasoning" && p.text?.includes(tag))).toBe(
        true,
      );
      for (const other of TASKS) {
        if (other.tag === tag) continue;
        expect(sub?.parts.some((p) => p.text?.includes(other.tag))).toBe(false);
      }
    }
  });

  it("keeps parent synthesis out of task cards when multiple tasks are calling", () => {
    dispatchAcp("", acpOutput("Summarizing all regions"));
    const store = useV2StreamingStore.getState();
    expect(store.byKey[`${SID}::${ACTOR}`]?.outputText).toContain("Summarizing");
    for (const { parentToolId } of TASKS) {
      const sub = store.subagentByToolId[parentToolId];
      expect(sub?.outputText ?? "").not.toContain("Summarizing");
    }
  });
});

describe("early bind from toolUse metadata", () => {
  beforeEach(() => {
    useV2StreamingStore.setState({
      byKey: {},
      revisionBySession: {},
      archived: [],
      persistedPlansBySession: {},
      subagentByToolId: {},
      archivedSubagentByToolId: {},
      childAcpSessionToToolId: {},
      pendingSubagentEvents: {},
    });
  });

  it("binds immediately from in_progress rawOutput", () => {
    useV2StreamingStore.getState().pushToolUse(SID, ACTOR, {
      toolId: "task-1",
      toolName: "task",
      description: "scan",
      params: { subagent_type: "general", prompt: "scan" },
      toolKind: "other",
      rawOutput: {
        metadata: { sessionId: "ses_child", parentSessionId: "ses_root" },
      },
    });
    expect(useV2StreamingStore.getState().childAcpSessionToToolId.ses_child).toBe(
      "task-1",
    );
  });
});

describe("permission bind uses sourceToolCallId", () => {
  beforeEach(() => {
    useV2StreamingStore.setState({
      byKey: {
        [`${SID}::${ACTOR}`]: {
          sessionId: SID,
          actorId: ACTOR,
          outputText: "",
          thinkingText: "",
          parts: [],
          toolCalls: [
            {
              id: "task-a",
              name: "task",
              status: "calling",
              arguments: { subagent_type: "general" },
              startTime: new Date(),
            },
            {
              id: "task-b",
              name: "task",
              status: "calling",
              arguments: { subagent_type: "general" },
              startTime: new Date(),
            },
          ],
          planEntries: [],
          pendingPermissionsByRequestId: {},
          errorMessage: null,
          errorDetails: null,
          lastUpdate: 0,
          active: true,
          streamId: "s1",
        },
      },
      revisionBySession: {},
      archived: [],
      persistedPlansBySession: {},
      subagentByToolId: {},
      archivedSubagentByToolId: {},
      childAcpSessionToToolId: {},
      pendingSubagentEvents: {},
    });
  });

  it("binds to explicit parent tool id", () => {
    tryBindChildFromPermission(SID, ACTOR, "ses_child_b", "task-b");
    expect(useV2StreamingStore.getState().childAcpSessionToToolId.ses_child_b).toBe(
      "task-b",
    );
  });

  it("does not bind without sourceToolCallId", () => {
    tryBindChildFromPermission(SID, ACTOR, "ses_child_b");
    expect(useV2StreamingStore.getState().childAcpSessionToToolId.ses_child_b).toBeUndefined();
  });
});

describe("subFinish on task complete", () => {
  beforeEach(() => {
    useV2StreamingStore.setState({
      byKey: {},
      revisionBySession: {},
      archived: [],
      persistedPlansBySession: {},
      subagentByToolId: {},
      archivedSubagentByToolId: {},
      childAcpSessionToToolId: {},
      pendingSubagentEvents: {},
    });
  });

  it("marks subagent inactive when parent task completes", () => {
    useV2StreamingStore.getState().pushToolUse(SID, ACTOR, {
      toolId: "task-1",
      toolName: "task",
      description: "scan",
      params: { subagent_type: "general", prompt: "scan" },
      toolKind: "other",
    });
    bindTaskChild(SID, ACTOR, "task-1", "ses_child", "metadata");
    useV2StreamingStore.getState().subAppendThinking("task-1", SID, ACTOR, "thinking");
    useV2StreamingStore.getState().completeToolUse(SID, ACTOR, {
      toolId: "task-1",
      success: true,
      summary: "done",
      rawOutput: {
        metadata: { sessionId: "ses_child", parentSessionId: "ses_root" },
      },
    });
    expect(useV2StreamingStore.getState().subagentByToolId["task-1"]?.active).toBe(false);
  });
});
