import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getPreferredLanguage, normalizeSupportedLanguage, persistLanguage } from './locale';

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

const getUserLanguage = (): string => {
  if (FORCED_LOCALE && FORCED_LOCALE !== 'all') {
    return FORCED_LOCALE;
  }

  return normalizeSupportedLanguage(getPreferredLanguage());
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

// Sync initial language to config file for gateway i18n
if (typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)) {
  import('@tauri-apps/api/core').then(({ invoke }) => {
    invoke('set_config_locale', { locale: i18n.language }).catch(() => {
      // Silently ignore — workspace may not be set yet
    });
  });
}

export default i18n;

// Export utility functions for language switching and persistence
export const changeLanguage = (lang: string) => {
  const normalizedLang = normalizeSupportedLanguage(lang);
  persistLanguage(normalizedLang);

  if (Object.keys(resources).includes(normalizedLang)) {
    i18n.changeLanguage(normalizedLang);
  }
};

export const getCurrentLanguage = () => {
  return i18n.language;
};
