export type ActorType = "human" | "agent";

export interface Actor {
  actorId: string;
  actorType: ActorType;
  displayName: string;
  avatarUrl?: string;
  deviceId?: string;
}

export type ActorEvent =
  | { kind: "chat_message"; actorId: string; timestampMs: number; text: string; mentionActorIds: string[] }
  | { kind: "actor_join"; actor: Actor; timestampMs: number }
  | { kind: "actor_leave"; actorId: string; timestampMs: number }
  | { kind: "agent_invoke"; actorId: string; targetDaemonId: string; workspacePath?: string; timestampMs: number }
  | { kind: "acp_thinking"; actorId: string; text: string; timestampMs: number }
  | { kind: "acp_output_delta"; actorId: string; delta: string; timestampMs: number }
  | { kind: "acp_tool_use"; actorId: string; toolName: string; params: unknown; toolUseId: string; timestampMs: number }
  | { kind: "acp_tool_result"; actorId: string; toolUseId: string; result: unknown; timestampMs: number }
  | { kind: "acp_permission_request"; actorId: string; requestId: string; tool: string; params: unknown; ttlSeconds: number; timestampMs: number }
  | { kind: "acp_permission_grant"; requestId: string; grantedBy: string; timestampMs: number }
  | { kind: "acp_permission_deny"; requestId: string; deniedBy: string; timestampMs: number }
  | { kind: "acp_error"; actorId: string; code: string; message: string; timestampMs: number };
