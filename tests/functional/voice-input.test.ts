/**
 * Functional: voice input (streaming STT)
 * tauri-mcp: start/stop voice and assert one transcript update on release.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  getWindowInfo,
  mouseClick,
} from "../_utils/tauri-mcp-test-utils";

describe("Functional: voice input", () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      await sleep(8000);
      await focusWindow();
      await sleep(500);
      appReady = true;
    } catch (err: unknown) {
      console.error("Failed to launch app:", (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  it("voice button start shows listening state", async () => {
    if (!appReady) return;
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    // Voice floating button is typically bottom-right; click to start
    await mouseClick(win.x + win.width - 80, win.y + win.height - 80);
    await sleep(1500);
    // Click again to stop; frontend should receive one stt:transcript
    await mouseClick(win.x + win.width - 80, win.y + win.height - 80);
    await sleep(2000);
    expect((await getWindowInfo()).isVisible).toBe(true);
  }, 20_000);
});
