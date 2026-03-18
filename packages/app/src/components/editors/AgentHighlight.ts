/**
 * AgentHighlight — Tiptap Extension for highlighting agent-modified text.
 *
 * Uses ProseMirror Decorations (not Marks) so highlights don't affect
 * the document content or markdown output.
 *
 * Usage:
 *   // Add to extensions
 *   AgentHighlight
 *
 *   // Highlight ranges
 *   editor.dispatch(
 *     editor.state.tr.setMeta(agentHighlightKey, {
 *       action: 'add',
 *       ranges: [{from: 10, to: 20}, ...]
 *     })
 *   )
 *
 *   // Clear all highlights
 *   editor.dispatch(
 *     editor.state.tr.setMeta(agentHighlightKey, { action: 'clear' })
 *   )
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { AgentChangeRange } from "./pm-diff-engine";

export const agentHighlightKey = new PluginKey("agentHighlight");

/** Metadata payload for the agent highlight plugin */
export interface AgentHighlightMeta {
  action: "add" | "clear" | "remove-batch";
  ranges?: AgentChangeRange[];
  batchId?: string;
}

/** Internal state: decoration set + batch tracking for independent fade timers */
interface HighlightState {
  decorations: DecorationSet;
  batches: Map<string, AgentChangeRange[]>;
}

/** Timeout for auto-fade in milliseconds */
const FADE_TIMEOUT = 5000;

let batchCounter = 0;

export const AgentHighlight = Extension.create({
  name: "agentHighlight",

  addProseMirrorPlugins() {
    const editorRef = this.editor;

    return [
      new Plugin({
        key: agentHighlightKey,

        state: {
          init(): HighlightState {
            return {
              decorations: DecorationSet.empty,
              batches: new Map(),
            };
          },

          apply(tr, state: HighlightState): HighlightState {
            const meta = tr.getMeta(agentHighlightKey) as
              | AgentHighlightMeta
              | undefined;

            if (!meta) {
              // Map existing decorations through document changes
              if (tr.docChanged) {
                return {
                  ...state,
                  decorations: state.decorations.map(tr.mapping, tr.doc),
                };
              }
              return state;
            }

            if (meta.action === "clear") {
              return {
                decorations: DecorationSet.empty,
                batches: new Map(),
              };
            }

            if (meta.action === "remove-batch" && meta.batchId) {
              const newBatches = new Map(state.batches);
              newBatches.delete(meta.batchId);

              // Rebuild decorations from remaining batches
              const allDecorations: Decoration[] = [];
              for (const ranges of newBatches.values()) {
                for (const range of ranges) {
                  if (range.from < tr.doc.content.size && range.to <= tr.doc.content.size) {
                    allDecorations.push(
                      Decoration.inline(range.from, range.to, {
                        class: "agent-highlight agent-highlight-fading",
                      }),
                    );
                  }
                }
              }

              return {
                decorations: DecorationSet.create(tr.doc, allDecorations),
                batches: newBatches,
              };
            }

            if (meta.action === "add" && meta.ranges && meta.ranges.length > 0) {
              const batchId = `batch-${++batchCounter}`;
              const validRanges = meta.ranges.filter(
                (r) => r.from < tr.doc.content.size && r.to <= tr.doc.content.size,
              );

              // Create decorations for new ranges
              const newDecorations = validRanges.map((range) =>
                Decoration.inline(range.from, range.to, {
                  class: "agent-highlight",
                }),
              );

              // Merge with existing decorations
              const merged = state.decorations.add(tr.doc, newDecorations);

              const newBatches = new Map(state.batches);
              newBatches.set(batchId, validRanges);

              // Schedule auto-fade for this batch
              setTimeout(() => {
                if (editorRef && !editorRef.isDestroyed) {
                  editorRef.view.dispatch(
                    editorRef.state.tr.setMeta(agentHighlightKey, {
                      action: "remove-batch",
                      batchId,
                    } as AgentHighlightMeta),
                  );
                }
              }, FADE_TIMEOUT);

              return {
                decorations: merged,
                batches: newBatches,
              };
            }

            return state;
          },
        },

        props: {
          decorations(state) {
            return (agentHighlightKey.getState(state) as HighlightState)
              ?.decorations;
          },
        },
      }),
    ];
  },
});
