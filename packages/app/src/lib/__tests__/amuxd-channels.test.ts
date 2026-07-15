import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listChannels,
  loadChannelConfig,
  saveChannelConfig,
  AmuxdUnreachableError,
} from "../amuxd-channels";
import * as tauri from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("amuxd-channels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws AmuxdUnreachableError when invoke rejects with reachability error", async () => {
    vi.mocked(tauri.invoke).mockRejectedValue("amuxd not reachable: foo");
    await expect(listChannels()).rejects.toBeInstanceOf(AmuxdUnreachableError);
  });

  it("returns channel array on success", async () => {
    vi.mocked(tauri.invoke).mockResolvedValue([
      {
        platform: "discord",
        enabled: true,
        connected: false,
        lastError: null,
      },
    ]);
    const result = await listChannels();
    expect(result[0].platform).toBe("discord");
  });

  it("maps WeCom multi-bot config to daemon field names on save", async () => {
    vi.mocked(tauri.invoke).mockResolvedValue(undefined);

    await saveChannelConfig("wecom", {
      enabled: true,
      bots: [
        {
          enabled: true,
          botId: "bot",
          secret: "sec",
          encodingAesKey: "aes",
        },
      ],
    });

    expect(tauri.invoke).toHaveBeenCalledWith("save_channel_config", {
      platform: "wecom",
      configJson: JSON.stringify({
        enabled: true,
        bots: [
          {
            enabled: true,
            bot_id: "bot",
            secret: "sec",
            encoding_aes_key: "aes",
          },
        ],
      }),
    });
  });

  it("maps daemon WeCom multi-bot config back to app field names on load", async () => {
    vi.mocked(tauri.invoke).mockResolvedValue({
      enabled: true,
      bots: [
        {
          enabled: true,
          bot_id: "bot",
          secret: "sec",
          encoding_aes_key: "aes",
        },
      ],
    });

    await expect(loadChannelConfig("wecom")).resolves.toEqual({
      enabled: true,
      bots: [
        {
          enabled: true,
          botId: "bot",
          secret: "sec",
          encodingAesKey: "aes",
        },
      ],
    });
  });

  it("migrates legacy single-bot WeCom daemon config on load", async () => {
    vi.mocked(tauri.invoke).mockResolvedValue({
      enabled: true,
      bot_id: "bot",
      secret: "sec",
      encoding_aes_key: "aes",
    });

    await expect(loadChannelConfig("wecom")).resolves.toEqual({
      enabled: true,
      bots: [
        {
          enabled: true,
          botId: "bot",
          secret: "sec",
          encodingAesKey: "aes",
        },
      ],
    });
  });
});
