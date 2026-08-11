/**
 * OpenCode `question` tool prompts, ported from the iOS
 * `SessionDetailViewModel.decodePendingQuestion` path.
 *
 * These arrive as ACP `raw` events (`question_asked` / `question_replied` /
 * `question_rejected`) rather than timeline rows: they are control-plane state
 * that blocks the turn until answered, so the composer surfaces them instead of
 * the feed rendering them.
 */

export type AcpQuestionOption = {
  label: string;
  description: string;
};

export type AcpQuestionPrompt = {
  id: string;
  header: string;
  question: string;
  options: AcpQuestionOption[];
  allowsMultiple: boolean;
};

export type PendingAcpQuestion = {
  id: string;
  agentActorId: string;
  questions: AcpQuestionPrompt[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function decodeOptions(raw: unknown): AcpQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AcpQuestionOption[] = [];
  for (const value of raw) {
    // Options are either bare labels or `{label, description}` objects.
    if (typeof value === "string") {
      if (value) out.push({ label: value, description: "" });
      continue;
    }
    const option = asRecord(value);
    const label = asString(option?.label);
    if (!label) continue;
    out.push({ label, description: asString(option?.description) });
  }
  return out;
}

/**
 * Decode a `question_asked` payload. Returns null when the payload has no
 * request id or yields no answerable question — a card with nothing to answer
 * would block the composer forever.
 */
export function decodePendingQuestion(
  payload: unknown,
  agentActorId: string,
): PendingAcpQuestion | null {
  const root = asRecord(payload);
  if (!root) return null;
  const id = asString(root.id);
  if (!id) return null;
  const rawQuestions = root.questions;
  if (!Array.isArray(rawQuestions)) return null;

  const questions: AcpQuestionPrompt[] = [];
  rawQuestions.forEach((entry, index) => {
    const raw = asRecord(entry);
    const question = asString(raw?.question);
    if (!question) return;
    questions.push({
      id: String(index),
      header: asString(raw?.header) || "Question",
      question,
      options: decodeOptions(raw?.options),
      allowsMultiple: raw?.multiple === true,
    });
  });

  if (questions.length === 0) return null;
  return { id, agentActorId, questions };
}

/** The request id a `question_replied` / `question_rejected` payload settles. */
export function decodeQuestionRequestId(payload: unknown): string | null {
  const root = asRecord(payload);
  if (!root) return null;
  return asString(root.requestID) || asString(root.id) || null;
}

/** Upsert by request id, preserving order — a re-ask replaces in place. */
export function upsertPendingQuestion(
  pending: ReadonlyArray<PendingAcpQuestion>,
  question: PendingAcpQuestion,
): PendingAcpQuestion[] {
  const index = pending.findIndex((entry) => entry.id === question.id);
  if (index < 0) return [...pending, question];
  const next = [...pending];
  next[index] = question;
  return next;
}

export function removePendingQuestion(
  pending: ReadonlyArray<PendingAcpQuestion>,
  requestId: string,
): PendingAcpQuestion[] {
  return pending.filter((entry) => entry.id !== requestId);
}

/**
 * Collapse the card's per-question state into the `answers_json` wire shape:
 * one array of selected labels per question, in order. A typed custom answer
 * wins over the checkbox selection for that question, matching iOS.
 */
export function buildQuestionAnswers(
  questions: ReadonlyArray<AcpQuestionPrompt>,
  selected: Readonly<Record<string, ReadonlyArray<string>>>,
  custom: Readonly<Record<string, string>>,
): string[][] {
  return questions.map((question) => {
    const typed = (custom[question.id] ?? "").trim();
    if (typed) return [typed];
    return [...(selected[question.id] ?? [])].sort();
  });
}

/** Every question must carry at least one answer before the card can submit. */
export function areAnswersComplete(answers: ReadonlyArray<ReadonlyArray<string>>): boolean {
  return answers.length > 0 && answers.every((entry) => entry.length > 0);
}
