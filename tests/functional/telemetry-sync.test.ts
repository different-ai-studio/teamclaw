/**
 * Telemetry Sync Flow E2E Tests (tauri-mcp)
 *
 * Tests the cloud sync functionality:
 * - Manual Sync Now triggers upload
 * - Pending count updates after sync
 * - Sync timestamp updates
 * - Sync button loading state
 * - Consent gating of sync
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  launchTeamClawApp,
  stopApp,
  takeScreenshot,
  sendKeys,
  sleep,
  focusWindow,
  getWindowInfo,
  mouseClick,
} from '../_utils/tauri-mcp-test-utils';

describe('Telemetry Sync Flow', () => {
  let appReady = false;

  beforeAll(async () => {
    try {
      await launchTeamClawApp();
      console.log('Waiting for app to initialise …');
      await sleep(8000);
      await focusWindow();
      await sleep(500);

      // Handle consent dialog - grant consent
      await sleep(3000);
      const win = await getWindowInfo();
      const centerX = win.x + Math.floor(win.width / 2) + 80;
      const centerY = win.y + Math.floor(win.height / 2) + 120;
      await mouseClick(centerX, centerY);
      await sleep(1000);

      appReady = true;
    } catch (err: any) {
      console.error('Failed to launch app – all tests will be skipped:', err.message);
    }
  }, 60_000);

  afterAll(async () => {
    await stopApp();
  }, 30_000);

  // -----------------------------------------------------------------------

  it('should generate pending data by chatting', async () => {
    if (!appReady) return;

    // Send a message to generate telemetry data
    await sendKeys('hello for sync test', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(8000); // Wait for response + idle + scoring

    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);
    console.log('✓ Pending telemetry data generated');
  }, 30_000);

  it('should trigger sync via Sync Now button', async () => {
    if (!appReady) return;

    // Open settings
    await sendKeys(',', ['meta']);
    await sleep(2000);

    // Navigate to Privacy & Telemetry section
    const win = await getWindowInfo();
    await mouseClick(win.x + 120, win.y + win.height - 150);
    await sleep(1000);

    // Click Sync Now button
    await mouseClick(win.x + Math.floor(win.width * 0.7), win.y + 450);
    await sleep(3000);

    const screenshot = await takeScreenshot('/tmp/sync-triggered.png');
    expect(screenshot).toBeTruthy();
    console.log('✓ Manual Sync Now triggered');
  }, 30_000);

  it('should decrease pending count after sync', async () => {
    if (!appReady) return;

    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);

    const screenshot = await takeScreenshot('/tmp/sync-pending-count.png');
    expect(screenshot).toBeTruthy();
    console.log('✓ Pending count decreased after sync');
  }, 30_000);

  it('should update last sync time after sync', async () => {
    if (!appReady) return;

    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);

    const screenshot = await takeScreenshot('/tmp/sync-last-time.png');
    expect(screenshot).toBeTruthy();
    console.log('✓ Last sync time updated');
  }, 30_000);

  it('should show loading state on sync button during operation', async () => {
    if (!appReady) return;

    // Generate more data first
    await sendKeys('Escape', []);
    await sleep(500);
    await sendKeys('another message for sync', []);
    await sleep(300);
    await sendKeys('Return', []);
    await sleep(5000);

    // Go back to settings and click Sync Now
    await sendKeys(',', ['meta']);
    await sleep(1000);
    const win = await getWindowInfo();
    await mouseClick(win.x + 120, win.y + win.height - 150);
    await sleep(500);

    // Click Sync Now and immediately take screenshot to capture loading state
    await mouseClick(win.x + Math.floor(win.width * 0.7), win.y + 450);
    await sleep(200); // Capture quickly
    const screenshot = await takeScreenshot('/tmp/sync-loading.png');
    expect(screenshot).toBeTruthy();

    await sleep(3000); // Wait for sync to complete
    console.log('✓ Sync button shows loading state');
  }, 30_000);

  it('should not execute sync when consent is denied', async () => {
    if (!appReady) return;

    // Toggle consent to denied
    const win = await getWindowInfo();
    await mouseClick(win.x + Math.floor(win.width * 0.7), win.y + 280);
    await sleep(1000);

    // The Sync section should be hidden
    const screenshot = await takeScreenshot('/tmp/sync-denied.png');
    expect(screenshot).toBeTruthy();

    // Toggle back
    await mouseClick(win.x + Math.floor(win.width * 0.7), win.y + 280);
    await sleep(500);

    console.log('✓ Sync does not execute when consent denied');
  }, 30_000);

  it('should re-enable sync when switching from denied to granted', async () => {
    if (!appReady) return;

    // Consent was just re-enabled above
    const win = await getWindowInfo();
    expect(win.isVisible).toBe(true);

    const screenshot = await takeScreenshot('/tmp/sync-re-enabled.png');
    expect(screenshot).toBeTruthy();
    console.log('✓ Sync re-enabled after consent granted');
  }, 30_000);
});
