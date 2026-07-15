import { create } from "zustand";
import { appendAcpDebugLineToFile } from "@/lib/acp-debug-file-log";
import { appShortName } from "@/lib/build-config";
import type { AcpEvent } from "@/lib/proto/amux_pb";

const ACP_DEBUG_ENABLED_KEY = `${appShortName}-acp-stream-debug`;

function readAcpDebugEnabled(): boolean {
  if (import.meta.env.VITE_ACP_DEBUG_STREAM === "true") return true;
  try {
    return localStorage.getItem(ACP_DEBUG_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

/** In-memory ring buffer for the debug panel (disk log keeps full history). */
export const ACP_DEBUG_MAX_LINES = 2000;
/** Max lines rendered in the panel scroll area. */
export const ACP_DEBUG_PANEL_LINES = 200;

export type AcpDebugLine = {
  id: string;
  ts: number;
  sessionId: string;
  topic: string;
  actorId: string;
  eventCase: string;
  payload: unknown;
};

function serializeAcpPayload(event: AcpEvent | undefined): unknown {
  if (!event?.event) return null;
  const { case: eventCase, value } = event.event;
  if (!eventCase) return null;
  try {
    return JSON.parse(
      JSON.stringify(
        { case: eventCase, value, model: event.model ?? "" },
        (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    );
  } catch {
    return { case: eventCase, value: String(value) };
  }
}

interface State {
  lines: AcpDebugLine[];
  enabled: boolean;
  append: (input: {
    sessionId?: string;
    topic: string;
    actorId?: string;
    /** e.g. live:acp.event, runtime_state, client:runtime_start */
    eventCase?: string;
    acpEvent?: AcpEvent;
    envelopeMeta?: Record<string, unknown>;
    payload?: unknown;
  }) => void;
  clear: () => void;
  setEnabled: (enabled: boolean) => void;
}

export const useAcpDebugStore = create<State>((set, get) => ({
  lines: [],
  enabled: readAcpDebugEnabled(),
  append: (input) => {
    if (!get().enabled) return;
    const line: AcpDebugLine = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      sessionId: input.sessionId ?? "",
      topic: input.topic,
      actorId: input.actorId ?? "",
      eventCase:
        input.eventCase ??
        (input.acpEvent?.event?.case ? `live:${input.acpEvent.event.case}` : "(none)"),
      payload:
        input.payload ??
        (input.envelopeMeta
          ? { envelope: input.envelopeMeta, acp: serializeAcpPayload(input.acpEvent) }
          : serializeAcpPayload(input.acpEvent)),
    };
    set((state) => {
      const next = [...state.lines, line];
      if (next.length > ACP_DEBUG_MAX_LINES) {
        next.splice(0, next.length - ACP_DEBUG_MAX_LINES);
      }
      return { lines: next };
    });
    void appendAcpDebugLineToFile(line);
  },
  clear: () => set({ lines: [] }),
  setEnabled: (enabled) => {
    try {
      localStorage.setItem(ACP_DEBUG_ENABLED_KEY, String(enabled));
    } catch {
      /* ignore */
    }
    set({ enabled });
  },
}));

export function isAcpDebugPanelVisible(): boolean {
  return useAcpDebugStore.getState().enabled;
}
