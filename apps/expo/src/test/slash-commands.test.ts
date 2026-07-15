import { describe, expect, it } from "vitest";

describe("slashPrefix", () => {
  it("returns the prefix when the message starts with /", async () => {
    const { slashPrefix } = await import(
      "../features/sessions/components/slash-commands"
    );
    expect(slashPrefix("/")).toBe("");
    expect(slashPrefix("/ask")).toBe("ask");
    expect(slashPrefix("/com")).toBe("com");
  });

  it("returns null for non-slash queries", async () => {
    const { slashPrefix } = await import(
      "../features/sessions/components/slash-commands"
    );
    expect(slashPrefix("")).toBeNull();
    expect(slashPrefix("hello")).toBeNull();
    expect(slashPrefix("/ask something")).toBeNull();
    expect(slashPrefix("/has space")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("returns commands whose name starts with the prefix, sorted", async () => {
    const { filterSlashCommands, BUILT_IN_SLASH_COMMANDS } = await import(
      "../features/sessions/components/slash-commands"
    );
    expect(filterSlashCommands(BUILT_IN_SLASH_COMMANDS, "c").map((c) => c.name)).toEqual([
      "clear",
      "compact",
      "cost",
    ]);
  });

  it("is case-insensitive on the prefix", async () => {
    const { filterSlashCommands, BUILT_IN_SLASH_COMMANDS } = await import(
      "../features/sessions/components/slash-commands"
    );
    expect(filterSlashCommands(BUILT_IN_SLASH_COMMANDS, "MO").map((c) => c.name)).toEqual([
      "model",
    ]);
  });

  it("returns the full set when prefix is empty", async () => {
    const { filterSlashCommands, BUILT_IN_SLASH_COMMANDS } = await import(
      "../features/sessions/components/slash-commands"
    );
    expect(filterSlashCommands(BUILT_IN_SLASH_COMMANDS, "").length).toBe(
      BUILT_IN_SLASH_COMMANDS.length,
    );
  });
});
