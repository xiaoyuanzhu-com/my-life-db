// frontend/app/lib/i18n/config.ts
import i18n from 'i18next';
import HttpBackend from 'i18next-http-backend';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_UI_LOCALE, isSupportedLocale } from './metadata';
import fallbackEn from './fallback/en.json';

// Read active locale from the <html lang> attribute that the Go backend
// injects on every HTML response. If absent or unsupported, fall back to
// the default. This is the ONE place locale is sourced.
function readActiveLocale(): string {
  if (typeof document === 'undefined') return DEFAULT_UI_LOCALE;
  const lang = document.documentElement.lang?.trim();
  if (lang && isSupportedLocale(lang)) return lang;
  return DEFAULT_UI_LOCALE;
}

void i18n
  .use(HttpBackend)
  .use(initReactI18next)
  .init({
    lng: readActiveLocale(),
    fallbackLng: 'en',
    // Namespaces MUST be listed here so i18next knows which to load on boot.
    // Add more namespaces over time; not all need to be preloaded.
    ns: ['common', 'settings', 'data', 'agent'],
    defaultNS: 'common',
    supportedLngs: ['en', 'zh-Hans'],
    // Bundle English inline so the app renders instantly even if the network
    // fetch for the active locale is slow or fails.
    resources: {
      en: fallbackEn,
    },
    // Only non-English locales go through the HTTP backend.
    // partialBundledLanguages lets us mix inline + fetched.
    partialBundledLanguages: true,
    backend: {
      loadPath: '/locales/{{lng}}/{{ns}}.json',
    },
    interpolation: {
      escapeValue: false, // React already escapes
    },
    react: {
      useSuspense: false, // don't wrap the whole app in Suspense for i18n
    },
    returnNull: false,
  });

export default i18n;
