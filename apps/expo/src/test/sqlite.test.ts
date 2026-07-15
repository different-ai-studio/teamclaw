import { describe, expect, it, vi } from "vitest";

import { runMigrations, MIGRATIONS } from "../lib/db/migrations";

type FakeDb = {
  execAsync: ReturnType<typeof vi.fn>;
  getFirstAsync: ReturnType<typeof vi.fn>;
};

function createFakeDb(initialVersion: number): FakeDb {
  return {
    execAsync: vi.fn().mockResolvedValue(undefined),
    getFirstAsync: vi.fn().mockResolvedValue({ user_version: initialVersion }),
  };
}

describe("runMigrations", () => {
  it("applies migrations from version 0 up to the latest", async () => {
    const db = createFakeDb(0);
    await runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
    // Every migration's `up` SQL should have been executed.
    expect(db.execAsync).toHaveBeenCalledWith(MIGRATIONS[0].up);
    expect(db.execAsync).toHaveBeenCalledWith(
      `PRAGMA user_version = ${MIGRATIONS.length};`,
    );
  });

  it("skips migrations already applied", async () => {
    const db = createFakeDb(MIGRATIONS.length);
    await runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
    // user_version pragma never updates because nothing was applied
    expect(db.execAsync).not.toHaveBeenCalledWith(
      expect.stringContaining("PRAGMA user_version ="),
    );
  });
});
