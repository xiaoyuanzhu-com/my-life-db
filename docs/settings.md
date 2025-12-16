# Settings

## Languages Setting

### Storage Format

Languages are stored as an ordered array of **BCP 47** language tags (IETF language tags).

```json
{
  "preferences": {
    "languages": ["en-US", "zh-Hans", "ja"]
  }
}
```

Database key: `preferences_languages`
Storage format: JSON array string (e.g., `["en-US", "zh-Hans", "ja"]`)

### BCP 47 Examples

| Tag | Description |
|-----|-------------|
| `en` | English |
| `zh-Hans` | Chinese (Simplified) |
| `zh-Hant` | Chinese (Traditional) |
| `ja` | Japanese |
| `ko` | Korean |
| `es` | Spanish |
| `fr` | French |
| `de` | German |
| `pt-BR` | Portuguese (Brazil) |
| `pt-PT` | Portuguese (Portugal) |

**Design principle**: Only include regional/script variants when they represent meaningful differences:
- Chinese: `zh-Hans` vs `zh-Hant` (Simplified vs Traditional scripts)
- Portuguese: `pt-BR` vs `pt-PT` (significant vocabulary/spelling differences)
- Other languages: Use base code only (e.g., `en`, `es`, `fr`)

### UI Requirements

1. **Tag-based input**: Languages should display as tags/chips, not free-form text inputs
2. **Searchable dropdown**: User types to filter from a predefined list of common languages
3. **Localized display names**: Show language names in their native locale using `Intl.DisplayNames`
   - `en-US` → "English (United States)"
   - `zh-Hans` → "简体中文"
   - `ja` → "日本語"
4. **Ordered list**: Users can drag to reorder (first = primary language)
5. **Remove**: Each tag has a remove button

### Implementation Notes

Use the browser's `Intl.DisplayNames` API to convert BCP 47 codes to display names:

```typescript
// Display in native language
const displayName = new Intl.DisplayNames([code], { type: 'language' }).of(code);
// 'ja' → '日本語'
// 'zh-Hans' → '简体中文'

// Display in English (for search/filtering)
const englishName = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
// 'ja' → 'Japanese'
// 'zh-Hans' → 'Simplified Chinese'
```

### Common Languages List

Minimal set of common BCP 47 tags (22 languages):

```typescript
const COMMON_LANGUAGES = [
  'en',        // English
  'zh-Hans',   // Chinese (Simplified)
  'zh-Hant',   // Chinese (Traditional)
  'ja',        // Japanese
  'ko',        // Korean
  'es',        // Spanish
  'fr',        // French
  'de',        // German
  'pt-BR',     // Portuguese (Brazil)
  'pt-PT',     // Portuguese (Portugal)
  'it',        // Italian
  'ru',        // Russian
  'ar',        // Arabic
  'hi',        // Hindi
  'th',        // Thai
  'vi',        // Vietnamese
  'id',        // Indonesian
  'nl',        // Dutch
  'pl',        // Polish
  'tr',        // Turkish
  'uk',        // Ukrainian
  'sv',        // Swedish
];
```
