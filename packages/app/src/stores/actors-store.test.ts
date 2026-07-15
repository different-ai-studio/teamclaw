import { describe, it, expect, beforeEach } from "vitest";
import { create as createActor } from "@bufbuild/protobuf";
import { ActorSchema, ActorType } from "@/lib/proto/teamclaw_pb";
import { useActorsStore } from "./actors-store";

beforeEach(() => {
  useActorsStore.setState({ byId: {} });
});

describe("actors-store", () => {
  const a = (id: string, name: string) =>
    createActor(ActorSchema, {
      actorId: id, actorType: ActorType.HUMAN, displayName: name, ownerMemberId: "",
    });

  it("upserts a single actor", () => {
    useActorsStore.getState().upsert(a("a1", "Zhang San"));
    expect(useActorsStore.getState().byId["a1"].displayName).toBe("Zhang San");
  });

  it("upsertMany merges without removing existing", () => {
    useActorsStore.getState().upsert(a("a1", "Zhang San"));
    useActorsStore.getState().upsertMany([a("a2", "Li Si"), a("a3", "Wang Wu")]);
    expect(Object.keys(useActorsStore.getState().byId)).toHaveLength(3);
  });

  it("get returns undefined for unknown actor", () => {
    expect(useActorsStore.getState().get("missing")).toBeUndefined();
  });
});
