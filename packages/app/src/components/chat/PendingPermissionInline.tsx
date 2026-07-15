import { StreamingAgentsDock } from "./StreamingAgentsDock";

/** Standalone approval dock when no agent is streaming (child session, tool-attached). */
export function PendingPermissionInline() {
  return <StreamingAgentsDock agents={[]} onInterrupt={() => {}} />;
}
