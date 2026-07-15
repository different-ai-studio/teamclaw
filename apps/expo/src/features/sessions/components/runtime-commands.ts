import type { RuntimeInfo } from "../../actors/connected-agent-types";
import type { SlashCommand } from "./slash-commands";

/**
 * Returns the slash commands the composer should surface for a session.
 * Mirrors iOS `SessionDetailViewModel.availableCommands`:
 *   - if any runtime in the session has announced commands, return the
 *     union (first occurrence wins on duplicate names)
 *   - otherwise return the built-in fallback set
 */
export function resolveSlashCommands(
  runtimeInfos: RuntimeInfo[],
  builtIn: readonly SlashCommand[],
): SlashCommand[] {
  const seen = new Set<string>();
  const dynamic: SlashCommand[] = [];
  for (const runtime of runtimeInfos) {
    for (const cmd of runtime.availableCommands) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      dynamic.push({
        name: cmd.name,
        description: cmd.description,
        inputHint: cmd.inputHint,
      });
    }
  }
  return dynamic.length > 0 ? dynamic : [...builtIn];
}
