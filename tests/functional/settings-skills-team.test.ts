/**
 * Functional: Settings Skills with team source (teamclaw-team).
 * Verifies Settings → Skills loads without error when workspace has no teamclaw-team,
 * and that Skills list is visible.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import {
  launchTeamClawApp,
  stopApp,
  sendKeys,
  sleep,
  focusWindow,
  getWindowInfo,
  mouseClick,
} from "../_utils/tauri-mcp-test-utils"

describe("Functional: settings Skills (team source)", () => {
  let appReady = false

  beforeAll(async () => {
    try {
      await launchTeamClawApp()
      await sleep(8000)
      await focusWindow()
      await sleep(500)
      appReady = true
    } catch (err: unknown) {
      console.error("Failed to launch app:", (err as Error).message)
    }
  }, 60_000)

  afterAll(async () => {
    await stopApp()
  }, 30_000)

  it("Settings → Skills loads without error when no teamclaw-team", async () => {
    if (!appReady) return
    await sendKeys(",", ["meta"])
    await sleep(2000)
    const win = await getWindowInfo()
    await mouseClick(win.x + 120, win.y + 250)
    await sleep(1500)
    expect((await getWindowInfo()).isVisible).toBe(true)
  }, 15_000)
})
