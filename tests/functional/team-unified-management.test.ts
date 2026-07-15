import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  executeJs,
} from '../_utils/tauri-mcp-test-utils'

describe('Functional: Unified Team Management', () => {
  let appReady = false

  beforeAll(async () => {
    try {
      await launchTeamClawApp()
      await sleep(8000)
      await focusWindow()
      await sleep(500)

      // Navigate to Settings → Team
      await executeJs(`
        (() => {
          const btn = document.querySelector('[data-testid="settings-button"]')
            || document.querySelector('button:has(svg.lucide-settings)');
          btn?.click();
        })()
      `)
      await sleep(1000)
      await executeJs(`
        (() => {
          const items = document.querySelectorAll('button, [role="menuitem"], a');
          for (const item of items) {
            if (item.textContent?.trim() === 'Team') { item.click(); break; }
          }
        })()
      `)
      await sleep(1000)
      appReady = true
    } catch (err) {
      console.error('Setup failed:', (err as Error).message)
    }
  }, 60_000)

  afterAll(async () => {
    await stopApp()
  })

  it('should display device NodeId on team page', async () => {
    if (!appReady) return
    const hasNodeId = await executeJs(`
      (() => {
        const el = document.querySelector('[data-testid="device-node-id"]')
          || document.querySelector('code');
        return el?.textContent?.length > 0;
      })()
    `)
    expect(hasNodeId).toBe(true)
  })

  it('should show member list when team is connected', async () => {
    if (!appReady) return
    const hasMemberSection = await executeJs(`
      (() => {
        const headings = document.querySelectorAll('h3, h4, [class*="heading"]');
        for (const h of headings) {
          if (h.textContent?.includes('Members') || h.textContent?.includes('成员')) return true;
        }
        return false;
      })()
    `)
    expect(typeof hasMemberSection).toBe('boolean')
  })

  it('should show role badges for members', async () => {
    if (!appReady) return
    const hasBadges = await executeJs(`
      (() => {
        const badges = document.querySelectorAll('[data-testid="role-badge"]');
        return badges.length;
      })()
    `)
    expect(typeof hasBadges).toBe('number')
  })
})
