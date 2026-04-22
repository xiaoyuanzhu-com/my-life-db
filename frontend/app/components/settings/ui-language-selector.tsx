import { useTranslation } from "react-i18next";
import i18n from "~/lib/i18n/config";
import {
  SUPPORTED_UI_LOCALES,
  LOCALE_NATIVE_NAMES,
  type UiLocale,
} from "~/lib/i18n/metadata";

interface UiLanguageSelectorProps {
  value: string | undefined;             // preferences.language (may be undefined/empty)
  onChange: (value: string | undefined) => void;
}

export function UiLanguageSelector({ value, onChange }: UiLanguageSelectorProps) {
  const { t } = useTranslation("settings");

  const handleChange = (next: string) => {
    const normalized = next === "" ? undefined : (next as UiLocale);
    onChange(normalized);
    // Swap catalogs immediately so the user sees the change without a page reload.
    // If normalized is undefined, fall back to the locale injected at boot.
    const target = normalized ?? document.documentElement.lang ?? "en";
    void i18n.changeLanguage(target);
  };

  return (
    <select
      className="w-full px-3 py-2 rounded-md border bg-background"
      value={value ?? ""}
      onChange={(e) => handleChange(e.target.value)}
    >
      <option value="">{t("general.uiLanguage.systemDefault", "System default")}</option>
      {SUPPORTED_UI_LOCALES.map((code) => (
        <option key={code} value={code}>
          {LOCALE_NATIVE_NAMES[code]}
        </option>
      ))}
    </select>
  );
}
