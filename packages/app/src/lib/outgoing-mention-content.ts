import type { AttachedAgent } from "@/packages/ai/prompt-input-insert-hooks";

/** Inline human mention chip (same shape as Skill/Role enhanced chips). */
export function buildHumanMentionChip(
  displayName: string,
  instruction?: string,
): string {
  const name = displayName.trim();
  const hint =
    instruction?.trim() ||
    `This message also mentions human ${name}`;
  return `[Mentioned: ${name}|instruction: ${hint}]`;
}

/** Agent mention stays as a structured prefix line. */
export function buildStructuredMentionLines(
  agent: Pick<AttachedAgent, "displayName"> | null,
): string[] {
  const agentName = agent?.displayName?.trim();
  if (!agentName) return [];
  return [`[Mentioned agents: ${agentName}]`];
}

export function hasStructuredMentionLines(content: string): boolean {
  return /\[Mentioned agents:[^\]]*\]/i.test(content);
}
