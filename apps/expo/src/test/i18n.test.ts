import { describe, expect, it } from "vitest";

import { normalizeSupportedLanguage } from "../lib/i18n/locale";
import { t } from "../lib/i18n";
import i18n from "../lib/i18n";

describe("normalizeSupportedLanguage", () => {
  it("maps English tags to en", () => {
    expect(normalizeSupportedLanguage("en")).toBe("en");
    expect(normalizeSupportedLanguage("en-US")).toBe("en");
    expect(normalizeSupportedLanguage("en-GB")).toBe("en");
  });

  it("maps any Chinese tag to zh-CN", () => {
    expect(normalizeSupportedLanguage("zh")).toBe("zh-CN");
    expect(normalizeSupportedLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeSupportedLanguage("zh-Hans")).toBe("zh-CN");
    expect(normalizeSupportedLanguage("zh-Hant")).toBe("zh-CN");
  });

  it("falls back to en for unknown tags", () => {
    expect(normalizeSupportedLanguage(null)).toBe("en");
    expect(normalizeSupportedLanguage("ja-JP")).toBe("en");
  });
});

describe("catalog", () => {
  it("looks up iOS-aligned login strings in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(t("Get Started")).toBe("开始使用");
    expect(t("Custom server")).toBe("自定义服务器");
    expect(t("Sign in or register")).toBe("登录或注册");
    expect(t("Connected to {{host}}.", { host: "api.example.com" })).toBe(
      "已连接到 api.example.com。",
    );
    await i18n.changeLanguage("en");
    expect(t("Get Started")).toBe("Get Started");
  });
});
