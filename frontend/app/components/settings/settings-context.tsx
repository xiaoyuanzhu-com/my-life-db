import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import type { UserSettings } from "~/lib/config/settings";
import { api } from "~/lib/api";
import i18n, { detectSystemLocale } from "~/lib/i18n/config";
import { parseApiError, formatApiError } from "~/lib/errors";

interface SettingsContextType {
  settings: Partial<UserSettings> | null;
  setSettings: (settings: Partial<UserSettings>) => void;
  isLoading: boolean;
  isSaving: boolean;
  saveMessage: string | null;
  saveSettings: (partialSettings: Partial<UserSettings>) => Promise<void>;
  originalSettings: Partial<UserSettings> | null;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

// Helper function to check if a string is masked (all asterisks)
function isMaskedApiKey(apiKey: string | undefined): boolean {
  if (!apiKey) return false;
  return /^\*+$/.test(apiKey);
}

// Helper function to remove unchanged masked API keys from update payload
function stripUnchangedMaskedKeys(
  updates: Partial<UserSettings>,
  original: Partial<UserSettings>
): Partial<UserSettings> {
  const cleaned = { ...updates };

  // Check Vendor OpenAI API key
  if (
    cleaned.vendors?.openai?.apiKey &&
    isMaskedApiKey(cleaned.vendors.openai.apiKey) &&
    cleaned.vendors.openai.apiKey === original.vendors?.openai?.apiKey
  ) {
    const { apiKey: _apiKey, ...rest } = cleaned.vendors.openai;
    cleaned.vendors = {
      ...cleaned.vendors,
      openai: Object.keys(rest).length > 0 ? (rest as any) : undefined,
    };
  }

  return cleaned;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Partial<UserSettings> | null>(null);
  const [originalSettings, setOriginalSettings] = useState<Partial<UserSettings> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const response = await api.get("/api/settings");
      const data = await response.json();
      setSettings(data);
      setOriginalSettings(data);
      // Apply saved preference if present; otherwise fall back to the system
      // locale so clearing the preference (or never having set one) actually
      // resets the UI rather than leaving whatever language was last applied.
      const target = data?.preferences?.language || detectSystemLocale();
      if (target !== i18n.language) {
        void i18n.changeLanguage(target);
      }
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setIsLoading(false);
    }
  }

  async function saveSettingsFn(partialSettings: Partial<UserSettings>) {
    if (!settings || !originalSettings) return;

    setIsSaving(true);
    setSaveMessage(null);

    try {
      // Merge only the provided fields with existing settings
      const updatedSettings = { ...settings, ...partialSettings };

      // Strip out unchanged masked API keys before sending
      const cleanedSettings = stripUnchangedMaskedKeys(updatedSettings, originalSettings);

      const response = await api.put("/api/settings", cleanedSettings);

      if (response.ok) {
        setSaveMessage(i18n.t('settings:toast.saveSuccess', 'Settings saved successfully!'));
        setTimeout(() => setSaveMessage(null), 3000);
        // Reload settings to sync with server
        await loadSettings();
      } else {
        const apiErr = await parseApiError(response);
        setSaveMessage(formatApiError(apiErr));
      }
    } catch (error) {
      console.error("Failed to save settings:", error);
      setSaveMessage(i18n.t('settings:toast.saveFailure', 'Failed to save settings'));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <SettingsContext.Provider
      value={{
        settings,
        setSettings,
        isLoading,
        isSaving,
        saveMessage,
        saveSettings: saveSettingsFn,
        originalSettings,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettingsContext() {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error("useSettingsContext must be used within a SettingsProvider");
  }
  return context;
}
