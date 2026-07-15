import { fromBinary } from "@bufbuild/protobuf";
import { RuntimeInfoSchema } from "@teamclaw/app/proto/amux_pb";

import type { RuntimeInfo } from "../../features/actors/connected-agent-types";

export function decodeRuntimeInfo(payload: Uint8Array): RuntimeInfo | null {
  try {
    const proto = fromBinary(RuntimeInfoSchema, payload);
    return {
      runtimeId: proto.runtimeId,
      agentType: proto.agentType,
      worktree: proto.worktree,
      branch: proto.branch,
      status: proto.status,
      startedAt: Number(proto.startedAt),
      currentPrompt: proto.currentPrompt,
      workspaceId: proto.workspaceId,
      sessionTitle: proto.sessionTitle,
      toolUseCount: proto.toolUseCount,
      availableModels: proto.availableModels.map((m) => ({
        id: m.id,
        displayName: m.displayName,
      })),
      currentModel: proto.currentModel,
      state: proto.state,
      stage: proto.stage,
      errorCode: proto.errorCode,
      errorMessage: proto.errorMessage,
      failedStage: proto.failedStage,
      availableCommands: proto.availableCommands.map((c) => ({
        name: c.name,
        description: c.description,
        inputHint: c.inputHint,
      })),
    };
  } catch {
    return null;
  }
}
