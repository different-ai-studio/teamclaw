export type SlashCommand = {
  name: string;
  description: string;
  inputHint: string;
};

/**
 * Universal fallback so the popup is usable before (or instead of) the
 * runtime emitting `AvailableCommandsUpdate`. Mirrors iOS
 * `SessionDetailViewModel.builtInSlashCommands`. When any agent in the
 * session has announced commands the dynamic list wins; this set is the
 * "nothing announced yet" baseline.
 */
export const BUILT_IN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "clear", description: "Clear conversation history", inputHint: "" },
  { name: "compact", description: "Compact the conversation", inputHint: "" },
  { name: "help", description: "Show available commands", inputHint: "" },
  { name: "model", description: "Switch the active model", inputHint: "" },
  { name: "cost", description: "Show session token cost", inputHint: "" },
];

/**
 * Returns the slash-prefix being typed at the head of `composerText`,
 * or `null` if the cursor doesn't belong to a slash query. Mirrors iOS
 * `slashPrefix` — matches only when the message starts with `/` and the
 * remainder is `[a-zA-Z0-9_-]*`.
 */
export function slashPrefix(composerText: string): string | null {
  const first = composerText.charAt(0);
  if (first !== "/") return null;
  const rest = composerText.slice(1);
  if (!/^[a-zA-Z0-9_-]*$/.test(rest)) return null;
  return rest;
}

export function filterSlashCommands(
  commands: readonly SlashCommand[],
  prefix: string,
): SlashCommand[] {
  const needle = prefix.toLowerCase();
  return [...commands]
    .filter((cmd) => cmd.name.startsWith(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
}
