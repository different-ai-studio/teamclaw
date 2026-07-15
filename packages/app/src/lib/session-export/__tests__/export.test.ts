import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MessageRow } from "@/lib/local-cache";
import { exportSessionFromRows } from "../index";
import turnMessages from "../__fixtures__/turn-messages.json";
import expectedOpenCode from "../__fixtures__/expected-opencode.json";

const SESSION_ID = "sess-export-1";
const FIXED_EXPORT_TIME = "2026-06-23T12:00:00.000Z";

describe("exportSessionFromRows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_EXPORT_TIME));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces a stable export envelope", () => {
    const bundle = exportSessionFromRows(
      SESSION_ID,
      turnMessages as MessageRow[],
    );

    expect(bundle.session_id).toBe(SESSION_ID);
    expect(bundle.exported_at).toBe(FIXED_EXPORT_TIME);
    expect(bundle.source).toEqual({ type: "teamclaw_local_cache" });
    expect(Array.isArray(bundle.messages)).toBe(true);
    expect(bundle.messages.length).toBeGreaterThan(0);
  });

  it("matches the golden OpenCode messages fixture", () => {
    const bundle = exportSessionFromRows(
      SESSION_ID,
      turnMessages as MessageRow[],
    );

    expect(bundle.messages).toEqual(expectedOpenCode);
  });
});
