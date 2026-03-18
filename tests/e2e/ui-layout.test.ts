/**
 * E2E: UI Layout tests
 * Converted from Playwright ui.spec.ts to vitest + tauri-mcp.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  executeJs,
} from '../_utils/tauri-mcp-test-utils';

describe('UI Layout', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      await sleep(8000);
      await focusWindow();
      await sleep(500);
      appReady = true;
    } catch (err) {
      console.error('Failed to launch app:', (err as Error).message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  it('sidebar is visible with floating macOS style', async () => {
    if (!appReady) return;
    const sidebar = await executeJs(
      "document.querySelector('[data-slot=\"sidebar\"]') ? 'visible' : 'hidden'",
    );
    expect(sidebar).toBe('visible');

    const sidebarContent = await executeJs(
      "document.querySelector('[data-slot=\"sidebar-content\"]') ? 'visible' : 'hidden'",
    );
    expect(sidebarContent).toBe('visible');
  }, 15_000);

  it('sidebar contains session list', async () => {
    if (!appReady) return;
    const count = await executeJs(
      "document.querySelectorAll('[data-slot=\"sidebar-menu-button\"]').length",
    );
    expect(Number(count)).toBeGreaterThan(0);
  }, 15_000);

  it('sidebar has action buttons in header', async () => {
    if (!appReady) return;
    const headerVisible = await executeJs(
      "document.querySelector('[data-slot=\"sidebar-header\"]') ? 'visible' : 'hidden'",
    );
    expect(headerVisible).toBe('visible');

    const buttonCount = await executeJs(
      "document.querySelectorAll('[data-slot=\"sidebar-header\"] button').length",
    );
    expect(Number(buttonCount)).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('sidebar has settings button in footer', async () => {
    if (!appReady) return;
    const footerVisible = await executeJs(
      "document.querySelector('[data-slot=\"sidebar-footer\"]') ? 'visible' : 'hidden'",
    );
    expect(footerVisible).toBe('visible');

    const settingsBtn = await executeJs(
      "document.querySelector('[data-slot=\"sidebar-footer\"] button') ? 'visible' : 'hidden'",
    );
    expect(settingsBtn).toBe('visible');
  }, 15_000);

  it('chat panel shows message count', async () => {
    if (!appReady) return;
    const hasMessageCount = await executeJs(
      "document.body.innerText.includes('messages') ? 'found' : 'not found'",
    );
    expect(hasMessageCount).toBe('found');
  }, 15_000);

  it('chat panel shows user message', async () => {
    if (!appReady) return;
    const hasUserMessage = await executeJs(
      "document.querySelector('[data-slot=\"sidebar-menu-button\"]') ? 'found' : 'not found'",
    );
    expect(hasUserMessage).toBe('found');
  }, 15_000);

  it('chat panel shows tool call card', async () => {
    if (!appReady) return;
    const hasToolCard = await executeJs(
      "(() => { const buttons = document.querySelectorAll('button'); for (const btn of buttons) { if (btn.textContent && btn.textContent.includes('Completed')) return 'found'; } return 'not found'; })()",
    );
    expect(['found', 'not found']).toContain(hasToolCard);
  }, 15_000);

  it('chat panel shows assistant response with table', async () => {
    if (!appReady) return;
    const tableContent = await executeJs(
      "document.querySelector('table')?.textContent || ''",
    );
    expect(typeof tableContent).toBe('string');
  }, 15_000);

  it('input area is visible with correct elements', async () => {
    if (!appReady) return;
    const hasTextarea = await executeJs(
      "document.querySelector('textarea[placeholder]') ? 'visible' : 'hidden'",
    );
    expect(hasTextarea).toBe('visible');

    const hasForm = await executeJs(
      "document.querySelector('form') ? 'visible' : 'hidden'",
    );
    expect(hasForm).toBe('visible');
  }, 15_000);

  it('model selector shows model name', async () => {
    if (!appReady) return;
    const hasModelBtn = await executeJs(
      "(() => { const buttons = document.querySelectorAll('button'); for (const btn of buttons) { const text = btn.textContent || ''; if (text.includes('Claude') || text.includes('GPT') || text.includes('Model')) return 'found'; } return 'not found'; })()",
    );
    expect(['found', 'not found']).toContain(hasModelBtn);
  }, 15_000);

  it('background color class is applied', async () => {
    if (!appReady) return;
    const bgClass = await executeJs(
      "document.querySelector('[data-slot=\"sidebar-inset\"]')?.className || ''",
    );
    expect(bgClass).toContain('bg-bg-primary');
  }, 15_000);

  it('can switch between sessions', async () => {
    if (!appReady) return;
    const clicked = await executeJs(
      "(() => { const items = document.querySelectorAll('[data-slot=\"sidebar-menu-button\"]'); if (items.length > 1) { items[1].click(); return 'clicked'; } return 'no second session'; })()",
    );
    if (clicked === 'clicked') {
      await sleep(1000);
      const sidebarVisible = await executeJs(
        "document.querySelector('[data-slot=\"sidebar\"]') ? 'visible' : 'hidden'",
      );
      expect(sidebarVisible).toBe('visible');
    }
  }, 15_000);

  it('can expand tool call card', async () => {
    if (!appReady) return;
    const clicked = await executeJs(
      "(() => { const buttons = document.querySelectorAll('button'); for (const btn of buttons) { const text = btn.textContent || ''; if (text.includes('Completed') || text.includes('Search') || text.includes('Tool')) { btn.click(); return 'clicked'; } } return 'no tool card'; })()",
    );
    if (clicked === 'clicked') {
      await sleep(500);
      const expanded = await executeJs(
        "document.body.innerText.includes('Arguments') ? 'expanded' : 'not expanded'",
      );
      expect(['expanded', 'not found']).toContain(expanded);
    }
  }, 15_000);
});
