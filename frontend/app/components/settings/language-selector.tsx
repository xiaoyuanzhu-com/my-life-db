import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { MultiTagInput, type TagOption } from "~/components/ui/multi-tag-input";
import {
  COMMON_LANGUAGES,
  getLanguageDisplayName,
  getNativeLanguageDisplayName,
} from "~/lib/i18n/languages";

interface LanguageSelectorProps {
  languages: string[];
  onChange: (languages: string[]) => void;
}

export function LanguageSelector({ languages, onChange }: LanguageSelectorProps) {
  const { t } = useTranslation('settings');
  // Build options with native labels and English search terms
  const options: TagOption[] = useMemo(() => {
    return COMMON_LANGUAGES.map((code) => ({
      value: code,
      label: getNativeLanguageDisplayName(code),
      searchTerms: [getLanguageDisplayName(code), code],
    }));
  }, []);

  return (
    <MultiTagInput
      options={options}
      selected={languages}
      onChange={onChange}
      placeholder={t('general.languages.searchPlaceholder', 'Search languages...')}
    />
  );
}
