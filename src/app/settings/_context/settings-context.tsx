'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import type { UserSettings } from '@/lib/config/settings';

interface SettingsContextType {
  settings: Partial<UserSettings> | null;
  setSettings: (settings: Partial<UserSettings>) => void;
  isLoading: boolean;
  isSaving: boolean;
  saveMessage: string | null;
  saveSettings: (partialSettings: Partial<UserSettings>) => Promise<void>;
  originalSettings: Partial<UserSettings> | null; // Track original loaded settings
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
  if (cleaned.vendors?.openai?.apiKey &&
      isMaskedApiKey(cleaned.vendors.openai.apiKey) &&
      cleaned.vendors.openai.apiKey === original.vendors?.openai?.apiKey) {
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
      const response = await fetch('/api/settings');
      const data = await response.json();
      setSettings(data);
      setOriginalSettings(data); // Track original values
    } catch (error) {
      console.error('Failed to load settings:', error);
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

      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cleanedSettings),
      });

      if (response.ok) {
        setSaveMessage('Settings saved successfully!');
        setTimeout(() => setSaveMessage(null), 3000);
        // Reload settings to sync with server
        await loadSettings();
      } else {
        const error = await response.json();
        setSaveMessage(`Error: ${error.error || 'Failed to save settings'}`);
      }
    } catch (error) {
      console.error('Failed to save settings:', error);
      setSaveMessage('Failed to save settings');
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
    throw new Error('useSettingsContext must be used within a SettingsProvider');
  }
  return context;
}
