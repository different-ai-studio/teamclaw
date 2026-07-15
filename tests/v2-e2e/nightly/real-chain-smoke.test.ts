import { existsSync } from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  executeJs,
  focusWindow,
  launchTeamClawApp,
  sleep,
  stopApp,
  takeScreenshot,
} from "../../_utils/tauri-mcp-test-utils";

const realChainEnabled = process.env.TEAMCLAW_E2E_REAL_CHAIN === "1";
const describeRealChain = realChainEnabled ? describe : describe.skip;

async function waitForConversationSurface(timeoutMs = 30_000): Promise<string> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const selector = await executeJs(`
      (() => {
        if (document.querySelector('[data-testid="chat-input-area"]')) return "chat-input-area";
        if (document.querySelector('[data-testid="v2-session-list-column"]')) return "v2-session-list-column";
        return "";
      })()
    `);

    if (selector) return selector;
    await sleep(500);
  }

  throw new Error("Timed out waiting for V2 conversation surface");
}

describeRealChain("V2 nightly real-chain smoke", () => {
  beforeAll(async () => {
    await launchTeamClawApp();
    await sleep(1_000);
    await focusWindow();
  });

  afterAll(async () => {
    await stopApp();
  });

  it("launches the app and reaches the conversation surface", async () => {
    const reachableSurface = await waitForConversationSurface();
    expect(["chat-input-area", "v2-session-list-column"]).toContain(reachableSurface);

    const bodyText = await executeJs("document.body.innerText.trim()");
    expect(bodyText.length).toBeGreaterThan(0);

    const screenshotPath = `/tmp/teamclaw-v2-nightly-${Date.now()}.png`;
    const screenshot = await takeScreenshot(screenshotPath);
    expect(screenshot).toBe(screenshotPath);
    expect(existsSync(screenshotPath)).toBe(true);
  });
});
