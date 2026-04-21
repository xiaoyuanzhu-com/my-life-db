// frontend/app/lib/i18n/metadata.ts
// Supported UI locales with their native display names. Keep this tiny —
// it's bundled into the main JS chunk so the language picker can render
// without waiting on network fetches.

export const SUPPORTED_UI_LOCALES = ['en', 'zh-Hans'] as const;
export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

export const LOCALE_NATIVE_NAMES: Record<UiLocale, string> = {
  'en': 'English',
  'zh-Hans': '简体中文',
};

export const DEFAULT_UI_LOCALE: UiLocale = 'en';

export function isSupportedLocale(code: string): code is UiLocale {
  return (SUPPORTED_UI_LOCALES as readonly string[]).includes(code);
}
