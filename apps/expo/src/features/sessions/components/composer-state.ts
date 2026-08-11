/**
 * Composer state machine and label formatting, ported from the iOS
 * `ComposerState` and `AgentButtonLabel`. Kept pure so it can be tested without
 * React Native.
 */

export type ComposerRightButton =
  /** Voice recording in progress — finish recording. */
  | "stopRecording"
  /** Idle, text non-empty. */
  | "send"
  /** Idle, text empty — start recording. */
  | "mic";

export type ComposerInputMode = "textField" | "waveform";

/**
 * The button to the right of the input.
 *
 * Note there is no interrupt here: multi-agent sessions moved interrupts onto
 * each agent's chip above the composer, so one runtime can be stopped without
 * touching the others.
 */
export function composerRightButton(args: {
  hasText: boolean;
  isRecording: boolean;
}): ComposerRightButton {
  if (args.isRecording) return "stopRecording";
  return args.hasText ? "send" : "mic";
}

export function composerInputMode(isRecording: boolean): ComposerInputMode {
  return isRecording ? "waveform" : "textField";
}

/**
 * Text after the `@` glyph on the agent button.
 *
 * Null means icon-only — no agent is selected. One agent shows its name; more
 * than one shows the first name and a count, so the button stays one line.
 */
export function agentButtonLabel(
  selectedDisplayNamesInOrder: ReadonlyArray<string>,
): string | null {
  const first = selectedDisplayNamesInOrder[0];
  if (!first) return null;
  if (selectedDisplayNamesInOrder.length === 1) return first;
  return `${first} ×${selectedDisplayNamesInOrder.length}`;
}
