import type {
  PendingPermissionEntry,
  PendingQuestionState,
  Session,
} from "@/stores/session-types";
import type { SessionStatusInfo } from "@/lib/opencode/sdk-sse";

export type SessionActivityState = "running" | "waiting";
export type SessionActivityKind = "streaming" | "retry" | "question" | "permission";

export interface SessionListActivity {
  state: SessionActivityState;
  kind: SessionActivityKind;
  count?: number;
}

export type SessionStatusesById = Record<string, SessionStatusInfo | undefined>;
export type PendingQuestionIdsBySession = Record<string, string[] | undefined>;

export function pendingQuestionActivityKey(question: Pick<PendingQuestionState, "questionId" | "toolCallId">): string {
  return question.questionId || question.toolCallId;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function addPendingQuestionActivity(
  current: PendingQuestionIdsBySession,
  sessionId: string | undefined | null,
  key: string | undefined | null,
): PendingQuestionIdsBySession {
  if (!sessionId || !key) return current;
  const nextKeys = unique([...(current[sessionId] || []), key]);
  if (nextKeys.length === (current[sessionId] || []).length) return current;
  return { ...current, [sessionId]: nextKeys };
}

export function removePendingQuestionActivity(
  current: PendingQuestionIdsBySession,
  sessionId: string | undefined | null,
  key: string | undefined | null,
): PendingQuestionIdsBySession {
  if (!sessionId || !key || !current[sessionId]) return current;
  const nextKeys = (current[sessionId] || []).filter((item) => item !== key);
  const next = { ...current };
  if (nextKeys.length > 0) {
    next[sessionId] = nextKeys;
  } else {
    delete next[sessionId];
  }
  return next;
}

export function removeSessionActivityEntries<T>(
  current: Record<string, T | undefined>,
  sessionId: string,
): Record<string, T | undefined> {
  if (!(sessionId in current)) return current;
  const next = { ...current };
  delete next[sessionId];
  return next;
}

export function updateSessionStatusEntry(
  current: SessionStatusesById,
  sessionId: string,
  status: SessionStatusInfo,
): SessionStatusesById {
  if (status.type === "idle") {
    return removeSessionActivityEntries(current, sessionId) as SessionStatusesById;
  }
  return { ...current, [sessionId]: status };
}

export function pruneSessionStatuses(
  current: SessionStatusesById,
  sessions: Session[],
): SessionStatusesById {
  const ids = new Set(sessions.map((session) => session.id));
  const next: SessionStatusesById = {};
  for (const [sessionId, status] of Object.entries(current)) {
    if (ids.has(sessionId) && status && status.type !== "idle") {
      next[sessionId] = status;
    }
  }
  return next;
}

export function resolveSessionActivityOwner(
  sessionId: string | undefined | null,
  sessions: Pick<Session, "id" | "parentID">[],
  fallbackSessionId?: string | null,
): string | null {
  const startingId = sessionId || fallbackSessionId || null;
  if (!startingId) return null;

  const byId = new Map(sessions.map((session) => [session.id, session]));
  let currentId: string | null = startingId;
  const seen = new Set<string>();

  while (currentId) {
    if (seen.has(currentId)) return currentId;
    seen.add(currentId);

    const session = byId.get(currentId);
    if (!session?.parentID) return currentId;
    currentId = session.parentID;
  }

  return fallbackSessionId || startingId;
}

export function resolvePendingPermissionActivityOwner(
  entry: PendingPermissionEntry,
  sessions: Pick<Session, "id" | "parentID">[],
  fallbackSessionId?: string | null,
): string | null {
  if (entry.ownerSessionId) return entry.ownerSessionId;
  return resolveSessionActivityOwner(
    entry.childSessionId || entry.permission.sessionID,
    sessions,
    entry.permission.sessionID || fallbackSessionId,
  );
}

export function resolvePendingQuestionActivityOwner(
  question: Pick<PendingQuestionState, "sessionId">,
  sessions: Pick<Session, "id" | "parentID">[],
  fallbackSessionId?: string | null,
): string | null {
  return resolveSessionActivityOwner(
    question.sessionId,
    sessions,
    question.sessionId || fallbackSessionId,
  );
}

function pickHigherPriority(
  current: SessionListActivity | undefined,
  next: SessionListActivity,
): SessionListActivity {
  if (!current) return next;
  if (current.state === "waiting") {
    if (next.state === "waiting" && next.count && current.count) {
      return { ...current, count: Math.max(current.count, next.count) };
    }
    return current;
  }
  return next.state === "waiting" ? next : current;
}

function countQuestions(
  questions: PendingQuestionState[],
  sessionId: string,
): number {
  return questions
    .filter((question) => question.sessionId === sessionId)
    .reduce((total, question) => total + Math.max(1, question.questions.length), 0);
}

export function buildSessionListActivityMap({
  sessions,
  activeSessionId,
  sessionStatuses,
  pendingQuestionIdsBySession,
  pendingQuestions,
  pendingPermissions,
  streamingMessageId,
  streamingChildSessionIds,
}: {
  sessions: Session[];
  activeSessionId: string | null;
  sessionStatuses: SessionStatusesById;
  pendingQuestionIdsBySession: PendingQuestionIdsBySession;
  pendingQuestions: PendingQuestionState[];
  pendingPermissions: PendingPermissionEntry[];
  streamingMessageId: string | null;
  streamingChildSessionIds: string[];
}): Map<string, SessionListActivity> {
  const result = new Map<string, SessionListActivity>();

  const mark = (sessionId: string | undefined | null, activity: SessionListActivity) => {
    const owner = resolveSessionActivityOwner(sessionId, sessions, activeSessionId);
    if (!owner) return;
    result.set(owner, pickHigherPriority(result.get(owner), activity));
  };

  for (const [sessionId, status] of Object.entries(sessionStatuses)) {
    if (!status || status.type === "idle") continue;
    mark(sessionId, {
      state: status.type === "retry" ? "waiting" : "running",
      kind: status.type === "retry" ? "retry" : "streaming",
    });
  }

  for (const [sessionId, keys] of Object.entries(pendingQuestionIdsBySession)) {
    if (keys && keys.length > 0) {
      mark(sessionId, { state: "waiting", kind: "question", count: Math.max(1, keys.length) });
    }
  }

  for (const question of pendingQuestions) {
    const sessionId = question.sessionId || activeSessionId;
    mark(sessionId, {
      state: "waiting",
      kind: "question",
      count: Math.max(1, countQuestions(pendingQuestions, sessionId || "")),
    });
  }

  for (const permission of pendingPermissions) {
    mark(resolvePendingPermissionActivityOwner(permission, sessions, activeSessionId), {
      state: "waiting",
      kind: "permission",
    });
  }

  if (streamingMessageId && activeSessionId) {
    mark(activeSessionId, { state: "running", kind: "streaming" });
  }

  for (const childSessionId of streamingChildSessionIds) {
    mark(childSessionId, { state: "running", kind: "streaming" });
  }

  return result;
}
