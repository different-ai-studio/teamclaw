import { extractWildcards } from "../../lib/mqtt/topic-match";
import type { TeamMqttClient } from "../../lib/mqtt/team-mqtt";
import type { RuntimeInfo } from "./connected-agent-types";

export type RuntimeStateSubscriber = {
  watchActor: (actorId: string) => void;
  unwatchActor: (actorId: string) => void;
  watchedActors: () => Set<string>;
  dispose: () => void;
};

type Deps = {
  mqtt: TeamMqttClient;
  teamId: string;
  decode: (payload: Uint8Array) => RuntimeInfo | null;
  onRuntimeInfo: (actorId: string, runtimeId: string, info: RuntimeInfo) => void;
};

export function createRuntimeStateSubscriber(deps: Deps): RuntimeStateSubscriber {
  const unsubscribes = new Map<string, () => void>();

  function topicFor(actorId: string) {
    return `amux/${deps.teamId}/${actorId}/runtime/+/state`;
  }

  return {
    watchActor(actorId) {
      if (unsubscribes.has(actorId)) return;
      const filter = topicFor(actorId);
      const off = deps.mqtt.subscribe(filter, (payload, topic) => {
        const segments = extractWildcards(
          `amux/${deps.teamId}/+/runtime/+/state`,
          topic,
        );
        if (!segments) return;
        const [, runtimeId] = segments;
        const info = deps.decode(payload);
        if (!info) return;
        deps.onRuntimeInfo(actorId, runtimeId, info);
      });
      unsubscribes.set(actorId, off);
    },
    unwatchActor(actorId) {
      const off = unsubscribes.get(actorId);
      if (off) { off(); unsubscribes.delete(actorId); }
    },
    watchedActors() {
      return new Set(unsubscribes.keys());
    },
    dispose() {
      for (const off of unsubscribes.values()) off();
      unsubscribes.clear();
    },
  };
}
