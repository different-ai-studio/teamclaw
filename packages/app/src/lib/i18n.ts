import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// Import translation files
import enTranslation from '../locales/en.json';
import zhCnTranslation from '../locales/zh-CN.json';

// Build-time locale selection via VITE_LOCALE env var:
//   undefined or 'all' → both languages (default)
//   'en'               → English only
//   'zh-CN'            → Chinese only
const FORCED_LOCALE = import.meta.env.VITE_LOCALE as string | undefined;

const allResources = {
  en: { translation: enTranslation },
  'zh-CN': { translation: zhCnTranslation },
};

const resources = FORCED_LOCALE && FORCED_LOCALE !== 'all'
  ? { [FORCED_LOCALE]: allResources[FORCED_LOCALE as keyof typeof allResources] }
  : allResources;

// Detect user's language preference
const getUserLanguage = (): string => {
  // Single-locale build — always use the forced locale
  if (FORCED_LOCALE && FORCED_LOCALE !== 'all') {
    return FORCED_LOCALE;
  }

  // Check for persisted language in localStorage
  const persistedLang = localStorage.getItem('teamclaw-language');
  if (persistedLang && Object.keys(resources).includes(persistedLang)) {
    return persistedLang;
  }

  // Fallback to browser language detection
  const browserLang = navigator.language;
  if (browserLang.startsWith('zh')) {
    return 'zh-CN';
  }

  // Default to English
  return 'en';
};

const defaultLng = FORCED_LOCALE && FORCED_LOCALE !== 'all' ? FORCED_LOCALE : 'en';

i18n
  .use(initReactI18next) // Passes i18n down to react-i18next
  .init({
    resources,
    lng: getUserLanguage(), // Set the initial language
    fallbackLng: defaultLng, // Fallback language
    interpolation: {
      escapeValue: false // React already escapes values
    },
    keySeparator: '.' // Enable nested key lookup (e.g., 'common.save' → common → save)
  });

export default i18n;

// Export utility functions for language switching and persistence
export const changeLanguage = (lang: string) => {
  if (Object.keys(resources).includes(lang)) {
    i18n.changeLanguage(lang);
    localStorage.setItem('teamclaw-language', lang); // Persist the language preference
  }
};

export const getCurrentLanguage = () => {
  return i18n.language;
};