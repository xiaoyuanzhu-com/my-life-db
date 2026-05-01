// frontend/app/lib/i18n/config.ts
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_UI_LOCALE, isSupportedLocale } from './metadata';

import enCommon from '~/locales/en/common.json';
import enSettings from '~/locales/en/settings.json';
import enData from '~/locales/en/data.json';
import enAgent from '~/locales/en/agent.json';
import enErrors from '~/locales/en/errors.json';
import zhHansCommon from '~/locales/zh-Hans/common.json';
import zhHansSettings from '~/locales/zh-Hans/settings.json';
import zhHansData from '~/locales/zh-Hans/data.json';
import zhHansAgent from '~/locales/zh-Hans/agent.json';
import zhHansErrors from '~/locales/zh-Hans/errors.json';

// Pick a locale from the browser. User preference from the server
// (preferences_language) is applied later by SettingsProvider via changeLanguage.
// Exported so callers (e.g., the language selector's "System default" path)
// can resolve the system locale fresh instead of reading the current i18n state.
export function detectSystemLocale(): string {
  if (typeof navigator === 'undefined') return DEFAULT_UI_LOCALE;
  const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const raw of candidates) {
    if (!raw) continue;
    if (isSupportedLocale(raw)) return raw;
    // Map bare zh / zh-CN / zh-SG → zh-Hans (simplified).
    if (/^zh(-|$)/i.test(raw) && !/Hant|TW|HK|MO/i.test(raw)) return 'zh-Hans';
  }
  return DEFAULT_UI_LOCALE;
}

void i18n.use(initReactI18next).init({
  lng: detectSystemLocale(),
  fallbackLng: 'en',
  ns: ['common', 'settings', 'data', 'agent', 'errors'],
  defaultNS: 'common',
  supportedLngs: ['en', 'zh-Hans'],
  resources: {
    en: {
      common: enCommon,
      settings: enSettings,
      data: enData,
      agent: enAgent,
      errors: enErrors,
    },
    'zh-Hans': {
      common: zhHansCommon,
      settings: zhHansSettings,
      data: zhHansData,
      agent: zhHansAgent,
      errors: zhHansErrors,
    },
  },
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
  returnNull: false,
});

// Keep the <html lang> attribute in sync so CSS :lang() selectors and
// assistive tech see the right value.
if (typeof document !== 'undefined') {
  document.documentElement.lang = i18n.language;
  i18n.on('languageChanged', (lng) => {
    document.documentElement.lang = lng;
  });
}

export default i18n;
