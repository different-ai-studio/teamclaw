import { create } from "zustand";
import { listenForEnvelopes, type IncomingEnvelope } from "@/lib/mqtt-bridge";
import { decodeLiveEvent, sessionIdFromTopic } from "@/lib/teamclaw-events";
import type { Message } from "@/lib/proto/teamclaw_pb";

interface BusState {
  perSession: Record<string, Message[]>;
  start: () => Promise<void>;
}

let started = false;

export const useSessionEventBus = create<BusState>((set, get) => ({
  perSession: {},
  start: async () => {
    if (started) return;
    started = true;
    await listenForEnvelopes((env: IncomingEnvelope) => {
      const sid = sessionIdFromTopic(env.topic);
      if (!sid) return;
      const decoded = decodeLiveEvent(new Uint8Array(env.bytes));
      if (!decoded?.message) return;
      const cur = get().perSession[sid] ?? [];
      set({ perSession: { ...get().perSession, [sid]: [...cur, decoded.message] } });
    });
  },
}));
