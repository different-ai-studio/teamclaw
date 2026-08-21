import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "../../locales/en.json";
import zhCN from "../../locales/zh-CN.json";
import { getSystemLanguage, type SupportedLanguage } from "./locale";

const resources = {
  en: { translation: en },
  "zh-CN": { translation: zhCN },
};

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: getSystemLanguage(),
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    // Catalog keys are English UI sentences, some with dots / colons.
    keySeparator: false,
    nsSeparator: false,
    returnNull: false,
  });
}

export default i18n;

export function t(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options);
}

export function getCurrentLanguage(): SupportedLanguage {
  const lng = i18n.language;
  return lng === "zh-CN" ? "zh-CN" : "en";
}
