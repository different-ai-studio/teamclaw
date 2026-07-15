import { describe, expect, it } from "vitest";

describe("parseTodoText", () => {
  it("recognizes [done] / [wip] / [todo] / [cancelled] prefixes", async () => {
    const { parseTodoText } = await import(
      "../features/sessions/components/todo-dock-parser"
    );
    const input = [
      "[done] Ship the chip bar",
      "[wip] Wire the todo dock",
      "[todo] Member sheet",
      "[cancelled] Old auth flow",
    ].join("\n");

    expect(parseTodoText(input)).toEqual([
      { content: "Ship the chip bar", status: "completed" },
      { content: "Wire the todo dock", status: "in_progress" },
      { content: "Member sheet", status: "pending" },
      { content: "Old auth flow", status: "cancelled" },
    ]);
  });

  it("defaults to pending when no prefix is present", async () => {
    const { parseTodoText } = await import(
      "../features/sessions/components/todo-dock-parser"
    );
    expect(parseTodoText("Plain reminder")).toEqual([
      { content: "Plain reminder", status: "pending" },
    ]);
  });

  it("skips blank lines and trims whitespace", async () => {
    const { parseTodoText } = await import(
      "../features/sessions/components/todo-dock-parser"
    );
    const input = "\n   [done]    Done item   \n\n[todo] Pending\n   \n";
    expect(parseTodoText(input)).toEqual([
      { content: "Done item", status: "completed" },
      { content: "Pending", status: "pending" },
    ]);
  });

  it("returns an empty array for empty input", async () => {
    const { parseTodoText } = await import(
      "../features/sessions/components/todo-dock-parser"
    );
    expect(parseTodoText("")).toEqual([]);
    expect(parseTodoText("\n\n")).toEqual([]);
  });
});

describe("countCompleted", () => {
  it("counts only items with completed status", async () => {
    const { countCompleted } = await import(
      "../features/sessions/components/todo-dock-parser"
    );
    expect(
      countCompleted([
        { content: "a", status: "completed" },
        { content: "b", status: "completed" },
        { content: "c", status: "pending" },
        { content: "d", status: "in_progress" },
      ]),
    ).toBe(2);
  });
});
