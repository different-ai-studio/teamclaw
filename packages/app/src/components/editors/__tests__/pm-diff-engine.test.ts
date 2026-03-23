import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { buildTextToPMMap, computeAgentChanges } from "../pm-diff-engine";

// Create a minimal ProseMirror schema for testing
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM() {
        return ["p", 0];
      },
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: "inline*",
      group: "block",
      parseDOM: [
        { tag: "h1", attrs: { level: 1 } },
        { tag: "h2", attrs: { level: 2 } },
        { tag: "h3", attrs: { level: 3 } },
      ],
      toDOM(node) {
        return [`h${node.attrs.level}`, 0];
      },
    },
    bulletList: {
      content: "listItem+",
      group: "block",
      parseDOM: [{ tag: "ul" }],
      toDOM() {
        return ["ul", 0];
      },
    },
    orderedList: {
      content: "listItem+",
      group: "block",
      parseDOM: [{ tag: "ol" }],
      toDOM() {
        return ["ol", 0];
      },
    },
    listItem: {
      content: "paragraph block*",
      parseDOM: [{ tag: "li" }],
      toDOM() {
        return ["li", 0];
      },
    },
    taskList: {
      content: "taskItem+",
      group: "block",
      parseDOM: [{ tag: "ul[data-type='taskList']" }],
      toDOM() {
        return ["ul", { "data-type": "taskList" }, 0];
      },
    },
    taskItem: {
      attrs: { checked: { default: false } },
      content: "paragraph block*",
      parseDOM: [
        {
          tag: "li[data-type='taskItem']",
          getAttrs(dom) {
            return {
              checked: (dom as HTMLElement).getAttribute("data-checked") === "true",
            };
          },
        },
      ],
      toDOM(node) {
        return [
          "li",
          { "data-type": "taskItem", "data-checked": node.attrs.checked },
          0,
        ];
      },
    },
    text: { group: "inline" },
  },
  marks: {
    bold: {
      parseDOM: [{ tag: "strong" }],
      toDOM() {
        return ["strong", 0];
      },
    },
    italic: {
      parseDOM: [{ tag: "em" }],
      toDOM() {
        return ["em", 0];
      },
    },
  },
});

/** Helper: create a PM doc from nodes */
function doc(...children: ReturnType<typeof p>[]) {
  return schema.node("doc", null, children);
}

function p(...content: (string | ReturnType<typeof bold>)[]) {
  const nodes = content.map((c) =>
    typeof c === "string" ? schema.text(c) : c,
  );
  return schema.node("paragraph", null, nodes);
}

function heading(level: number, text: string) {
  return schema.node("heading", { level }, [schema.text(text)]);
}

function bold(text: string) {
  return schema.text(text, [schema.marks.bold.create()]);
}

function taskList(...items: ReturnType<typeof taskItem>[]) {
  return schema.node("taskList", null, items);
}

function taskItem(checked: boolean, ...content: ReturnType<typeof p>[]) {
  return schema.node("taskItem", { checked }, content);
}

// ---- Tests: computeAgentChanges ----

describe("computeAgentChanges", () => {
  // 8.1
  it("returns empty ranges for identical documents", () => {
    const oldDoc = doc(p("Hello world"));
    const newDoc = doc(p("Hello world"));
    const result = computeAgentChanges(oldDoc, newDoc);
    expect(result.ranges).toEqual([]);
    expect(result.changePercent).toBe(0);
  });

  // 8.2
  it("returns ranges for single word replacement", () => {
    const oldDoc = doc(p("The quick brown fox"));
    const newDoc = doc(p("The quick red fox"));
    const result = computeAgentChanges(oldDoc, newDoc);
    expect(result.ranges.length).toBeGreaterThanOrEqual(1);
    // The added characters should cover at least part of "red"
    // (diffChars may share the 'r' between "brown" and "red")
    const highlightedText = result.ranges
      .map((r) => newDoc.textBetween(r.from, r.to))
      .join("");
    // The highlighted text should contain new characters
    expect(highlightedText.length).toBeGreaterThan(0);
    expect(result.changePercent).toBeGreaterThan(0);
  });

  // 8.3
  it("returns a range covering inserted text", () => {
    const oldDoc = doc(p("Hello world"));
    const newDoc = doc(p("Hello beautiful world"));
    const result = computeAgentChanges(oldDoc, newDoc);
    expect(result.ranges.length).toBe(1);
    const range = result.ranges[0];
    const insertedText = newDoc.textBetween(range.from, range.to);
    expect(insertedText).toBe("beautiful ");
  });

  // 8.4
  it("returns information indicating deletion", () => {
    const oldDoc = doc(p("Hello beautiful world"));
    const newDoc = doc(p("Hello world"));
    const result = computeAgentChanges(oldDoc, newDoc);
    // Deletions don't produce ranges in the new doc (nothing to highlight)
    // but changePercent should reflect the deletion
    expect(result.changePercent).toBeGreaterThan(0);
  });

  // 8.5
  it("returns separate ranges for multiple scattered changes", () => {
    const oldDoc = doc(p("The quick brown fox jumps over the lazy dog"));
    const newDoc = doc(p("The slow brown cat jumps over the fast dog"));
    const result = computeAgentChanges(oldDoc, newDoc);
    // "quick" → "slow", "fox" → "cat", "lazy" → "fast"
    // diffChars may produce more granular ranges due to shared characters
    expect(result.ranges.length).toBeGreaterThanOrEqual(3);
    // All highlighted text should be from the new version
    const allHighlighted = result.ranges
      .map((r) => newDoc.textBetween(r.from, r.to))
      .join("");
    // Should contain characters from the replacement words
    expect(allHighlighted).toContain("sl");
    expect(allHighlighted).toContain("cat");
    // "fast" shares 'a' with "lazy" at char level, so we may get "fst"
    expect(allHighlighted).toMatch(/f[as]*t/);
  });
});

// ---- Tests: buildTextToPMMap ----

describe("buildTextToPMMap", () => {
  // 8.6
  it("maps text offsets correctly for simple paragraph", () => {
    const d = doc(p("Hello"));
    const map = buildTextToPMMap(d);
    // In a doc with single paragraph "Hello":
    // doc pos 0, paragraph starts at pos 0, text starts at pos 1
    // H=pos1, e=pos2, l=pos3, l=pos4, o=pos5
    expect(map[0]).toBe(1); // 'H' at PM pos 1
    expect(map[4]).toBe(5); // 'o' at PM pos 5
    expect(map.length).toBe(5); // 5 characters
  });

  // 8.7
  it("maps text offsets correctly for heading node", () => {
    const d = doc(heading(1, "Title"));
    const map = buildTextToPMMap(d);
    // heading starts at pos 0, text starts at pos 1
    expect(map[0]).toBe(1); // 'T' at PM pos 1
    expect(map[4]).toBe(5); // 'e' at PM pos 5
  });

  // 8.8
  it("maps text offsets correctly for formatted text (bold, italic)", () => {
    const d = doc(p("Hello ", bold("world")));
    const map = buildTextToPMMap(d);
    // text content: "Hello world" (11 chars)
    // paragraph starts at pos 0
    // "Hello " = pos 1-6
    // "world" (bold) = pos 7-11
    expect(map[0]).toBe(1); // 'H'
    expect(map[5]).toBe(6); // ' '
    expect(map[6]).toBe(7); // 'w' (bold)
    expect(map[10]).toBe(11); // 'd' (bold)
  });

  // 8.9
  it("maps text offsets across multi-block document", () => {
    const d = doc(heading(1, "Title"), p("Body text"));
    const map = buildTextToPMMap(d);
    const textContent = d.textBetween(0, d.content.size, "\n", "");
    expect(textContent).toBe("Title\nBody text");
    // "Title" = 0-4, "\n" = 5, "Body text" = 6-14
    // heading: pos 0, text starts at 1 → T=1,i=2,t=3,l=4,e=5
    // separator "\n" between blocks
    // paragraph: starts after heading (heading size = 7), so paragraph starts at pos 7
    // text starts at pos 8 → B=8,o=9,d=10,y=11,...
    expect(map[0]).toBe(1); // 'T' in heading
    expect(map[6]).toBe(8); // 'B' in paragraph
  });

  // 8.10
  it("maps text offsets for task list items", () => {
    const d = doc(taskList(taskItem(false, p("Task one"))));
    const map = buildTextToPMMap(d);
    const textContent = d.textBetween(0, d.content.size, "\n", "");
    expect(textContent).toBe("Task one");
    // taskList > taskItem > paragraph > text
    // taskList pos 0, taskItem pos 1, paragraph pos 2, text starts at pos 3
    expect(map[0]).toBe(3); // 'T'
    expect(map[7]).toBe(10); // 'e'
  });
});

// ---- Tests: change percentage ----

describe("change percentage calculation", () => {
  // 8.11
  it("calculates small edit percentage correctly", () => {
    // Create a long document with 1000-char-equivalent text
    const longText = "a".repeat(995);
    const oldDoc = doc(p(longText));
    // Replace 5 chars
    const newText = "b".repeat(5) + longText.slice(5);
    const newDoc = doc(p(newText));
    const result = computeAgentChanges(oldDoc, newDoc);
    // ~1% change (5 added + 5 removed = 10, out of 995)
    expect(result.changePercent).toBeLessThan(5);
    expect(result.changePercent).toBeGreaterThan(0);
  });

  // 8.12
  it("calculates large rewrite percentage correctly", () => {
    const oldText = "a".repeat(1000);
    const oldDoc = doc(p(oldText));
    const newText = "b".repeat(600) + "a".repeat(400);
    const newDoc = doc(p(newText));
    const result = computeAgentChanges(oldDoc, newDoc);
    // 600 new "b" chars out of 1000 total = 60%
    expect(result.changePercent).toBeGreaterThan(50);
    expect(result.changePercent).toBeLessThanOrEqual(100);
  });
});
