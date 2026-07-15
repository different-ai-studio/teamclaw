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
  const existing = store.byRuntimeId[runtimeId] ?? store.byRuntimeId[daemonActorId];
  if (existing) return;

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
