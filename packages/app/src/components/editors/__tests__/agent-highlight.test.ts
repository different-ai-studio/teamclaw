import { describe, it, expect, vi, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AgentHighlight, agentHighlightKey } from "../AgentHighlight";
import type { AgentHighlightMeta } from "../AgentHighlight";
import { DecorationSet } from "@tiptap/pm/view";

// Helper to create a test editor
function createEditor(content = "<p>Hello world this is a test</p>") {
  return new Editor({
    extensions: [StarterKit, AgentHighlight],
    content,
    // Needed for node env (vitest/jsdom)
    element: document.createElement("div"),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentHighlight extension", () => {
  // 10.1
  it("creates correct DecorationSet from highlight ranges", () => {
    const editor = createEditor();

    // Add highlights for positions 1-5 ("Hello")
    editor.view.dispatch(
      editor.state.tr.setMeta(agentHighlightKey, {
        action: "add",
        ranges: [{ from: 1, to: 6 }],
      } as AgentHighlightMeta),
    );

    const state = agentHighlightKey.getState(editor.state) as {
      decorations: DecorationSet;
      batches: Map<string, unknown[]>;
    };

    expect(state.decorations).not.toBe(DecorationSet.empty);
    // Find decorations in the range
    const decos = state.decorations.find(1, 6);
    expect(decos.length).toBeGreaterThan(0);

    editor.destroy();
  });

  // 10.2
  it("maps decorations correctly through subsequent transactions", () => {
    const editor = createEditor();

    // Add highlight at positions 1-6 ("Hello")
    editor.view.dispatch(
      editor.state.tr.setMeta(agentHighlightKey, {
        action: "add",
        ranges: [{ from: 1, to: 6 }],
      } as AgentHighlightMeta),
    );

    // Now insert text at the beginning (position 1), which should shift decorations
    editor.chain().focus().insertContentAt(1, "NEW ").run();

    const state = agentHighlightKey.getState(editor.state) as {
      decorations: DecorationSet;
      batches: Map<string, unknown[]>;
    };

    // Decorations should have been mapped through the change
    expect(state.decorations).not.toBe(DecorationSet.empty);
    // The original "Hello" is now shifted by 4 chars ("NEW ")
    const decos = state.decorations.find(5, 10);
    expect(decos.length).toBeGreaterThan(0);

    editor.destroy();
  });

  // 10.3
  it("clears all decorations on clear action", () => {
    const editor = createEditor();

    // Add highlights
    editor.view.dispatch(
      editor.state.tr.setMeta(agentHighlightKey, {
        action: "add",
        ranges: [{ from: 1, to: 6 }],
      } as AgentHighlightMeta),
    );

    // Verify highlights exist
    let state = agentHighlightKey.getState(editor.state) as {
      decorations: DecorationSet;
      batches: Map<string, unknown[]>;
    };
    expect(state.decorations.find(1, 6).length).toBeGreaterThan(0);

    // Clear all
    editor.view.dispatch(
      editor.state.tr.setMeta(agentHighlightKey, {
        action: "clear",
      } as AgentHighlightMeta),
    );

    state = agentHighlightKey.getState(editor.state) as {
      decorations: DecorationSet;
      batches: Map<string, unknown[]>;
    };
    expect(state.decorations).toBe(DecorationSet.empty);
    expect(state.batches.size).toBe(0);

    editor.destroy();
  });

  // 10.4
  it("supports multiple highlight batches coexisting independently", () => {
    const editor = createEditor();

    // Add first batch
    editor.view.dispatch(
      editor.state.tr.setMeta(agentHighlightKey, {
        action: "add",
        ranges: [{ from: 1, to: 6 }],
      } as AgentHighlightMeta),
    );

    // Add second batch
    editor.view.dispatch(
      editor.state.tr.setMeta(agentHighlightKey, {
        action: "add",
        ranges: [{ from: 7, to: 12 }],
      } as AgentHighlightMeta),
    );

    const state = agentHighlightKey.getState(editor.state) as {
      decorations: DecorationSet;
      batches: Map<string, unknown[]>;
    };

    // Should have 2 batches
    expect(state.batches.size).toBe(2);

    // Both ranges should have decorations
    expect(state.decorations.find(1, 6).length).toBeGreaterThan(0);
    expect(state.decorations.find(7, 12).length).toBeGreaterThan(0);

    editor.destroy();
  });

  // 10.5
  it("decorations use agent-highlight CSS class", () => {
    const editor = createEditor();

    editor.view.dispatch(
      editor.state.tr.setMeta(agentHighlightKey, {
        action: "add",
        ranges: [{ from: 1, to: 6 }],
      } as AgentHighlightMeta),
    );

    const state = agentHighlightKey.getState(editor.state) as {
      decorations: DecorationSet;
    };

    const decos = state.decorations.find(1, 6);
    expect(decos.length).toBeGreaterThan(0);

    // Check the decoration spec has the correct class
    const spec = (decos[0] as unknown as { type: { attrs: { class: string } } }).type
      .attrs;
    expect(spec.class).toContain("agent-highlight");

    editor.destroy();
  });
});
