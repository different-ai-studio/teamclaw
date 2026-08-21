export const SUPPORTED_LANGUAGES = ["en", "zh-CN"] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isSupportedLanguage(
  language: string | null | undefined,
): language is SupportedLanguage {
  return SUPPORTED_LANGUAGES.includes(language as SupportedLanguage);
}

/**
 * Map any BCP-47 tag onto the two locales this app ships: English, or
 * Simplified Chinese. Mirrors desktop `normalizeSupportedLanguage` and iOS's
 * `en` / `zh-Hans` catalog — any `zh-*` (including zh-Hant) lands on zh-CN.
 */
export function normalizeSupportedLanguage(language: string | null | undefined): SupportedLanguage {
  if (!language) return "en";
  const normalized = language.toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  return "en";
}

/** Device language. Follows the OS the way iOS does — no in-app override. */
export function getSystemLanguage(): SupportedLanguage {
  try {
    // Lazy require so unit tests that never touch localization still load.
    const Localization = require("expo-localization") as {
      getLocales?: () => Array<{ languageTag?: string | null }>;
    };
    const locales = Localization.getLocales?.() ?? [];
    for (const locale of locales) {
      const tag = locale.languageTag;
      if (!tag) continue;
      const language = normalizeSupportedLanguage(tag);
      if (language !== "en" || tag.toLowerCase().startsWith("en")) {
        return language;
      }
    }
  } catch {
    // expo-localization unavailable (tests, or a bare Node import).
  }
  return "en";
}

export function dateLocale(language: SupportedLanguage = getSystemLanguage()): string {
  return language === "zh-CN" ? "zh-CN" : "en-US";
}
