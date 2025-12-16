import { useMemo } from "react";
import { MultiTagInput, type TagOption } from "~/components/ui/multi-tag-input";

// Common BCP 47 language tags (minimal set, regional variants only where meaningful)
const COMMON_LANGUAGES = [
  "en",
  "zh-Hans",
  "zh-Hant",
  "ja",
  "ko",
  "es",
  "fr",
  "de",
  "pt-BR",
  "pt-PT",
  "it",
  "ru",
  "ar",
  "hi",
  "th",
  "vi",
  "id",
  "nl",
  "pl",
  "tr",
  "uk",
  "sv",
];

// Get display name in native language
function getNativeDisplayName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

// Get display name in English (for search)
function getEnglishDisplayName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

interface LanguageSelectorProps {
  languages: string[];
  onChange: (languages: string[]) => void;
}

export function LanguageSelector({ languages, onChange }: LanguageSelectorProps) {
  // Build options with native labels and English search terms
  const options: TagOption[] = useMemo(() => {
    return COMMON_LANGUAGES.map((code) => ({
      value: code,
      label: getNativeDisplayName(code),
      searchTerms: [getEnglishDisplayName(code), code],
    }));
  }, []);

  return (
    <MultiTagInput
      options={options}
      selected={languages}
      onChange={onChange}
      placeholder="Search languages..."
    />
  );
}
