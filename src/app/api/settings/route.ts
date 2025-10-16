import { NextRequest, NextResponse } from 'next/server';
import { loadSettings, saveSettings, resetSettings } from '@/lib/config/storage';
import { validateAIConfig, sanitizeSettings } from '@/lib/config/settings';
import type { UserSettings } from '@/lib/config/settings';

/**
 * GET /api/settings
 * Get current user settings
 */
export async function GET() {
  try {
    const settings = await loadSettings();

    // Sanitize sensitive data before sending
    const sanitized = sanitizeSettings(settings);

    return NextResponse.json(sanitized);
  } catch (error) {
    console.error('Error loading settings:', error);
    return NextResponse.json(
      { error: 'Failed to load settings' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/settings
 * Update user settings
 */
export async function PUT(request: NextRequest) {
  try {
    const updates = await request.json() as Partial<UserSettings>;

    // Validate AI config if being updated
    if (updates.ai) {
      const validation = validateAIConfig(updates.ai);
      if (!validation.valid) {
        return NextResponse.json(
          { error: validation.error },
          { status: 400 }
        );
      }
    }

    // Load current settings
    const currentSettings = await loadSettings();

    // Merge updates
    const updatedSettings: UserSettings = {
      ...currentSettings,
      ...updates,
      preferences: {
        ...currentSettings.preferences,
        ...updates.preferences,
      },
      ai: {
        ...currentSettings.ai,
        ...updates.ai,
      },
      extraction: {
        ...currentSettings.extraction,
        ...updates.extraction,
      },
      storage: {
        ...currentSettings.storage,
        ...updates.storage,
      },
    };

    // Save settings
    await saveSettings(updatedSettings);

    // Return sanitized settings
    const sanitized = sanitizeSettings(updatedSettings);

    return NextResponse.json(sanitized);
  } catch (error) {
    console.error('Error updating settings:', error);
    return NextResponse.json(
      { error: 'Failed to update settings', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/settings/reset
 * Reset settings to defaults
 */
export async function POST(request: NextRequest) {
  try {
    const { action } = await request.json();

    if (action === 'reset') {
      const settings = await resetSettings();
      const sanitized = sanitizeSettings(settings);

      return NextResponse.json(sanitized);
    }

    return NextResponse.json(
      { error: 'Invalid action' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Error resetting settings:', error);
    return NextResponse.json(
      { error: 'Failed to reset settings' },
      { status: 500 }
    );
  }
}
