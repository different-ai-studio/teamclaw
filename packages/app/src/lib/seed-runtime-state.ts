import { create } from "@bufbuild/protobuf";
import {
  AgentStatus,
  RuntimeInfoSchema,
  RuntimeLifecycle,
  type RuntimeInfo,
} from "@/lib/proto/amux_pb";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";

/**
 * After runtimeStart RPC succeeds, seed a minimal local runtime-state entry so
 * lifecycle/status UI can render before MQTT retain arrives. Model options come
 * only from daemon ACP `available_models` on the retain — never seeded here.
 */
export function seedRuntimeStateAfterStart(args: {
  daemonActorId: string;
  runtimeId: string;
  agentType: number;
}): void {
  const daemonActorId = args.daemonActorId.trim();
  const runtimeId = args.runtimeId.trim();
  if (!daemonActorId || !runtimeId) return;

  const store = useRuntimeStateStore.getState();
  const existingMirror = store.byRuntimeId[daemonActorId];
  const existingSpawn = store.byRuntimeId[runtimeId];
  // Idempotent when this spawn is already indexed. Do NOT skip just because a
  // mirror entry exists — after runtimeStart returns a NEW spawn id the old
  // agent-UUID retain can still point at a dead spawn (e.g. MQTT was down when
  // the previous session stopped). Skipping then leaves setModel targeting the
  // stale id while the daemon holds the fresh one.
  if (
    existingSpawn?.info.runtimeId === runtimeId &&
    existingMirror?.info.runtimeId === runtimeId
  ) {
    return;
  }

  const info: RuntimeInfo = create(RuntimeInfoSchema, {
    runtimeId,
    agentType: args.agentType,
    state: RuntimeLifecycle.ACTIVE,
    status: AgentStatus.IDLE,
    availableModels: [],
  });

  store.upsert(runtimeId, daemonActorId, info);
  if (runtimeId !== daemonActorId) {
    store.upsert(daemonActorId, daemonActorId, info);
  }
}
