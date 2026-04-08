import type { Question } from "@/lib/opencode/sdk-types";

export type TerminalPromptKind =
  | "confirm"
  | "password"
  | "selection"
  | "continue"
  | "generic";

const INTERACTIVE_TERMINAL_PATTERNS = [
  /(?:^|\n)\s*(?:password|passphrase)(?: for .*?)?:\s*$/im,
  /\[(?:Y\/n|y\/N|y\/n|Y\/N)\]/,
  /\((?:y\/n|yes\/no)\)/i,
  /(?:are you sure|continue\?|proceed\?|confirm)/i,
  /do you want to continue/i,
  /press (?:enter|return|any key)/i,
  /\btype\s+['"`]?(?:yes|y|no|n)['"`]?\s+to continue/i,
  /enter (?:your )?(?:choice|selection|password|passphrase)/i,
  /select (?:an option|a number|one of)/i,
] as const;

const YES_NO_PATTERNS = [/\[(?:Y\/n|y\/N|y\/n|Y\/N)\]/, /\((?:y\/n|yes\/no)\)/i] as const;
const PASSWORD_PATTERN = /(?:^|\n)\s*(?:password|passphrase)(?: for .*?)?:\s*$/im;
const CONTINUE_PATTERN = /press (?:enter|return|any key)/i;
const SELECTION_PATTERN = /select (?:an option|a number|one of)|enter (?:your )?(?:choice|selection)/i;

export function getTerminalPromptKind(output: string): TerminalPromptKind {
  const normalized = output.trim();
  if (!normalized) return "generic";
  if (PASSWORD_PATTERN.test(normalized)) return "password";
  if (YES_NO_PATTERNS.some((pattern) => pattern.test(normalized))) return "confirm";
  if (CONTINUE_PATTERN.test(normalized)) return "continue";
  if (SELECTION_PATTERN.test(normalized)) return "selection";
  return "generic";
}

export function getCommandText(
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return "";
  return (
    (typeof args.command === "string" ? args.command : null) ||
    (typeof args.cmd === "string" ? args.cmd : null) ||
    (typeof args.input === "string" ? args.input : null) ||
    ""
  );
}

export function getToolCallOutputText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const resultObj = result as Record<string, unknown>;
    return (
      (typeof resultObj.raw === "string" ? resultObj.raw : null) ||
      (typeof resultObj.output === "string" ? resultObj.output : null) ||
      (typeof resultObj.result === "string" ? resultObj.result : null) ||
      (typeof resultObj.text === "string" ? resultObj.text : null) ||
      ""
    );
  }
  return "";
}

export function isLikelyTerminalPromptText(output: string): boolean {
  const normalized = output.trim();
  if (!normalized) return false;
  return INTERACTIVE_TERMINAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function extractTerminalPromptSnippet(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) return "";

  const tail = lines.slice(-4).join("\n").trim();
  return tail.length > 280 ? tail.slice(-280) : tail;
}

export function makeSyntheticTerminalQuestionId(toolCallId: string): string {
  return `terminal-input:${toolCallId}`;
}

export function isSyntheticTerminalQuestionId(questionId: string): boolean {
  return questionId.startsWith("terminal-input:");
}

export function buildTerminalInputQuestion(
  command: string,
  output: string,
): Question {
  const prompt = extractTerminalPromptSnippet(output);
  const promptKind = getTerminalPromptKind(prompt);

  const options =
    promptKind === "confirm"
      ? [
          { label: "Yes", value: "yes" },
          { label: "No", value: "no" },
          { label: "Cancel command", value: "cancel" },
        ]
      : promptKind === "continue"
        ? [
            { label: "Continue", value: "continue" },
            { label: "Cancel command", value: "cancel" },
          ]
        : promptKind === "selection"
          ? [{ label: "Cancel command", value: "cancel" }]
          : promptKind === "password"
            ? [{ label: "Cancel command", value: "cancel" }]
            : [{ label: "Cancel command", value: "cancel" }];

  return {
    id: "terminal-input",
    header: "Terminal Input",
    question: [
      "The terminal command is waiting for input.",
      command ? `Command: ${command}` : "",
      prompt ? `Prompt:\n${prompt}` : "",
      "What should the assistant send or do next?",
    ]
      .filter(Boolean)
      .join("\n\n"),
    options,
  };
}

export function isTerminalCancelAnswer(answer: string): boolean {
  return ["cancel", "cancel command", "stop", "abort"].includes(
    answer.trim().toLowerCase(),
  );
}

export function buildTerminalInputFollowUpMessage(params: {
  command: string;
  prompt: string;
  answer: string;
  kind: TerminalPromptKind;
}): string {
  const { command, prompt, answer, kind } = params;

  const instruction =
    kind === "confirm"
      ? "Retry or continue the task in a non-interactive way that applies the user's confirmation choice safely."
      : kind === "password"
        ? "If a secret is required, use the user-provided value carefully and avoid printing it back unnecessarily. Prefer a safer non-interactive path if available."
        : kind === "continue"
          ? "Continue the task without relying on another blocking terminal prompt if possible."
          : kind === "selection"
            ? "Continue the task using the user's selected input, and prefer a non-interactive retry."
            : "Continue the task using the user's requested terminal input, and avoid another blocking prompt if possible.";

  return [
    "The previous terminal command got stuck waiting for interactive input.",
    command ? `Command: \`${command}\`` : "",
    prompt ? `Observed prompt:\n\`\`\`\n${prompt}\n\`\`\`` : "",
    `User wants this response: \`${answer}\``,
    "Please continue the task in the same session.",
    instruction,
    "If true stdin input is still required, explicitly ask before running another blocking command.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
