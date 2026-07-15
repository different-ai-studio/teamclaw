import { create } from "zustand";
import type { Actor } from "@/lib/proto/teamclaw_pb";

interface ActorsState {
  byId: Record<string, Actor>;
  upsert: (a: Actor) => void;
  upsertMany: (a: Actor[]) => void;
  get: (actorId: string) => Actor | undefined;
}

export const useActorsStore = create<ActorsState>((set, get) => ({
  byId: {},
  upsert: (a) => set({ byId: { ...get().byId, [a.actorId]: a } }),
  upsertMany: (actors) => {
    const next = { ...get().byId };
    for (const a of actors) next[a.actorId] = a;
    set({ byId: next });
  },
  get: (actorId) => get().byId[actorId],
}));
