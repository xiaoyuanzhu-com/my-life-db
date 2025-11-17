import { useState, useEffect } from 'react';
import type { UserSettings } from '@/lib/config/settings';

export function useSettings() {
  const [settings, setSettings] = useState<Partial<UserSettings> | null>(null);
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
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function saveSettings(partialSettings: Partial<UserSettings>) {
    if (!settings) return;

    setIsSaving(true);
    setSaveMessage(null);

    try {
      // Merge only the provided fields with existing settings
      const updatedSettings = { ...settings, ...partialSettings };

      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedSettings),
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

  return {
    settings,
    setSettings,
    isLoading,
    isSaving,
    saveMessage,
    saveSettings,
  };
}
