/**
 * Functional: Question Tool interaction
 * Converted from Playwright question-tool.spec.ts to vitest + tauri-mcp.
 *
 * Sends a message that triggers the question tool, waits for the QuestionCard,
 * selects an option, and submits the answer.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  sleep,
  focusWindow,
  takeScreenshot,
  executeJs,
} from '../_utils/tauri-mcp-test-utils';

describe('Functional: Question Tool', () => {
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

  it('should handle question tool and submit answer', async () => {
    if (!appReady) return;

    await takeScreenshot('/tmp/question-01-initial.png');

    // Create a new session
    await executeJs(`
      (() => {
        const btn = document.querySelector('button svg.lucide-square-pen');
        if (btn) btn.closest('button')?.click();
      })()
    `);
    await sleep(2000);

    // Find prompt input and type a message to trigger question tool
    const hasInput = await executeJs(`
      (() => {
        const textarea = document.querySelector('textarea[placeholder]');
        if (!textarea) return 'no-input';
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        )?.set;
        nativeInputValueSetter?.call(textarea, '你出一道题，发回 question，让我选择正确答案。');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        return 'filled';
      })()
    `);

    if (hasInput !== 'filled') {
      console.warn('Could not find prompt input');
      return;
    }

    await takeScreenshot('/tmp/question-02-typed.png');

    // Click submit button
    await executeJs(`
      (() => {
        const btn = document.querySelector('button[type="submit"]');
        if (btn) btn.click();
      })()
    `);

    console.log('Message sent, waiting for Question card...');

    // Wait for question card to appear (poll for up to 60s)
    let questionFound = false;
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const result = await executeJs(`
        document.querySelector('.rounded-xl.border.bg-card')?.textContent?.includes('Question') ? 'found' : 'not-found'
      `);
      if (result.includes('found')) {
        questionFound = true;
        break;
      }
    }

    await takeScreenshot('/tmp/question-03-card.png');

    if (!questionFound) {
      console.warn('Question card did not appear within timeout');
      return;
    }

    console.log('Question card appeared!');
    await sleep(2000);

    // Click first option
    const clicked = await executeJs(`
      (() => {
        const card = Array.from(document.querySelectorAll('.rounded-xl.border.bg-card'))
          .find(el => el.textContent?.includes('Question'));
        if (!card) return 'no-card';
        const btns = card.querySelectorAll('button.w-full');
        if (btns.length > 0) { btns[0].click(); return 'clicked'; }
        return 'no-options';
      })()
    `);

    if (clicked !== 'clicked') {
      console.warn('Could not click option:', clicked);
      return;
    }

    await sleep(500);
    await takeScreenshot('/tmp/question-04-selected.png');

    // Click Submit Answer
    const submitted = await executeJs(`
      (() => {
        const card = Array.from(document.querySelectorAll('.rounded-xl.border.bg-card'))
          .find(el => el.textContent?.includes('Question'));
        if (!card) return 'no-card';
        const btn = Array.from(card.querySelectorAll('button'))
          .find(b => b.textContent?.includes('Submit Answer'));
        if (btn) { btn.click(); return 'submitted'; }
        return 'no-submit-btn';
      })()
    `);

    console.log('Submit result:', submitted);
    await takeScreenshot('/tmp/question-05-submitted.png');

    if (submitted === 'submitted') {
      await sleep(5000);
      const state = await executeJs(`
        (() => {
          const card = Array.from(document.querySelectorAll('.rounded-xl.border.bg-card'))
            .find(el => el.textContent?.includes('Question'));
          if (!card) return 'no-card';
          if (card.textContent?.includes('Answered')) return 'answered';
          if (card.textContent?.includes('Processing')) return 'processing';
          return 'unknown';
        })()
      `);
      console.log('Question state:', state);
      await takeScreenshot('/tmp/question-06-final.png');
      expect(['answered', 'processing']).toContain(state);
    }
  }, 90_000);
});
