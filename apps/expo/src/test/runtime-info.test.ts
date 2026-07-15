import { describe, expect, it } from "vitest";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  RuntimeInfoSchema,
  AcpAvailableCommandSchema,
  ModelInfoSchema,
} from "@teamclaw/app/proto/amux_pb";

import { decodeRuntimeInfo } from "../lib/teamclaw/runtime-info";

describe("decodeRuntimeInfo", () => {
  it("decodes a roundtripped RuntimeInfo", () => {
    const proto = create(RuntimeInfoSchema, {
      runtimeId: "r1",
      agentType: 1,
      worktree: "/repo",
      branch: "main",
      status: 1,
      startedAt: BigInt(1234567890),
      currentPrompt: "",
      workspaceId: "ws-1",
      sessionTitle: "Hello",
      toolUseCount: 3,
      availableModels: [
        create(ModelInfoSchema, { id: "m1", displayName: "Model 1" }),
      ],
      currentModel: "m1",
      state: 2,
      stage: "",
      errorCode: "",
      errorMessage: "",
      failedStage: "",
      availableCommands: [
        create(AcpAvailableCommandSchema, { name: "clear", description: "Clear chat", inputHint: "" }),
        create(AcpAvailableCommandSchema, { name: "model", description: "Switch", inputHint: "name" }),
      ],
    });
    const payload = toBinary(RuntimeInfoSchema, proto);
    const decoded = decodeRuntimeInfo(payload);
    expect(decoded).not.toBeNull();
    expect(decoded?.runtimeId).toBe("r1");
    expect(decoded?.workspaceId).toBe("ws-1");
    expect(decoded?.toolUseCount).toBe(3);
    expect(decoded?.availableModels).toEqual([{ id: "m1", displayName: "Model 1" }]);
    expect(decoded?.availableCommands).toEqual([
      { name: "clear", description: "Clear chat", inputHint: "" },
      { name: "model", description: "Switch", inputHint: "name" },
    ]);
    expect(decoded?.startedAt).toBe(1234567890);
  });

  it("returns null on malformed payload", () => {
    expect(decodeRuntimeInfo(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeNull();
  });

  it("returns empty arrays for missing collections", () => {
    const proto = create(RuntimeInfoSchema, { runtimeId: "r1" });
    const payload = toBinary(RuntimeInfoSchema, proto);
    const decoded = decodeRuntimeInfo(payload);
    expect(decoded?.availableCommands).toEqual([]);
    expect(decoded?.availableModels).toEqual([]);
  });
});
