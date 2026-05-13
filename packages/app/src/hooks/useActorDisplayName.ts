import * as React from "react";
import { supabase } from "@/lib/supabase-client";
import { useRuntimeStateStore } from "@/stores/runtime-state-store";

const actorDisplayNameCache = new Map<string, string>();
const inflightLookups = new Map<string, Promise<string | null>>();

async function lookupActorDisplayName(actorId: string): Promise<string | null> {
  const cached = actorDisplayNameCache.get(actorId);
  if (cached) return cached;
  const inflight = inflightLookups.get(actorId);
  if (inflight) return inflight;

  const p = (async () => {
    const { data, error } = await supabase
      .from("actor_directory")
      .select("display_name")
      .eq("id", actorId)
      .maybeSingle();
    if (error || !data) return null;
    const name = (data as { display_name?: string }).display_name ?? null;
    if (name) actorDisplayNameCache.set(actorId, name);
    return name;
  })();
  inflightLookups.set(actorId, p);
  try {
    return await p;
  } finally {
    inflightLookups.delete(actorId);
  }
}

export function useActorDisplayName(actorId: string | undefined | null): string {
  const [name, setName] = React.useState<string | null>(() =>
    actorId ? actorDisplayNameCache.get(actorId) ?? null : null,
  );
  React.useEffect(() => {
    if (!actorId || name) return;
    let cancelled = false;
    void lookupActorDisplayName(actorId).then((resolved) => {
      if (!cancelled && resolved) setName(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [actorId, name]);
  if (!actorId) return "";
  return name ?? actorId.slice(0, 8);
}

/** Find the current model an agent is using by matching daemonDeviceId
 * (== actor_id by daemon convention) against runtime-state-store entries.
 * Returns "" when no runtime is known for this actor. */
export function useAgentModelByActor(actorId: string | undefined | null): string {
  const byRuntimeId = useRuntimeStateStore((s) => s.byRuntimeId);
  return React.useMemo(() => {
    if (!actorId) return "";
    for (const entry of Object.values(byRuntimeId)) {
      if (entry.daemonDeviceId === actorId) {
        return entry.info.currentModel ?? "";
      }
    }
    return "";
  }, [actorId, byRuntimeId]);
}
