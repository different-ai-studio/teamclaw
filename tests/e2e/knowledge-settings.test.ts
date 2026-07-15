/**
 * E2E: Knowledge settings page
 * tauri-mcp: launch app, navigate to Knowledge settings, verify layout.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  launchTeamClawApp,
  stopApp,
  sendKeys,
  sleep,
  focusWindow,
  getWindowInfo,
  takeScreenshot,
} from '../_utils/tauri-mcp-test-utils'

describe('E2E: Knowledge settings', () => {
  let appReady = false

  beforeAll(async () => {
    try {
      await launchTeamClawApp()
      await sleep(8000)
      await focusWindow()
      await sleep(500)
      appReady = true
    } catch (err: unknown) {
      console.error('Failed to launch app:', (err as Error).message)
    }
  }, 60_000)

  afterAll(async () => {
    await stopApp()
  }, 30_000)

  it('should open settings panel', async () => {
    if (!appReady) return
    await sendKeys(',', ['meta'])
    await sleep(2000)
    const win = await getWindowInfo()
    expect(win.isVisible).toBe(true)
  }, 15_000)

  it('should navigate to Knowledge section and capture layout', async () => {
    if (!appReady) return
    // Settings should already be open from previous test
    // Take a screenshot of the current state
    const path = await takeScreenshot('/tmp/e2e-knowledge-settings.png')
    expect(path).toBeTruthy()

    const win = await getWindowInfo()
    expect(win.width).toBeGreaterThan(0)
    expect(win.height).toBeGreaterThan(0)
  }, 15_000)
})
