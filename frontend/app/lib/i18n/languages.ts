/**
 * Shared language utilities for BCP 47 language tags
 *
 * Used by both UI components and server-side code for consistent language handling.
 */

// Common BCP 47 language tags (minimal set, regional variants only where meaningful)
export const COMMON_LANGUAGES = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'es',
  'fr',
  'de',
  'pt-BR',
  'pt-PT',
  'it',
  'ru',
  'ar',
  'hi',
  'th',
  'vi',
  'id',
  'nl',
  'pl',
  'tr',
  'uk',
  'sv',
] as const;

export type CommonLanguageCode = (typeof COMMON_LANGUAGES)[number];

/**
 * Get display name for a language code in English.
 * Uses Intl.DisplayNames API which works in both browser and Node.js.
 *
 * @param code BCP 47 language tag (e.g., 'en', 'zh-Hans', 'ja')
 * @returns English display name (e.g., 'English', 'Simplified Chinese', 'Japanese')
 */
export function getLanguageDisplayName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

/**
 * Get display name for a language code in its native script.
 *
 * @param code BCP 47 language tag (e.g., 'en', 'zh-Hans', 'ja')
 * @returns Native display name (e.g., 'English', '简体中文', '日本語')
 */
export function getNativeLanguageDisplayName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}
