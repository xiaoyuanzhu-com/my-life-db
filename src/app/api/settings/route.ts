import { NextRequest, NextResponse } from 'next/server';
import { loadSettings, saveSettings, resetSettings } from '@/lib/config/storage';
import { validateAIConfig, sanitizeSettings } from '@/lib/config/settings';
import type { UserSettings } from '@/lib/config/settings';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiSettings' });

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
    log.error({ err: error }, 'load settings failed');
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

    // Load current settings
    const currentSettings = await loadSettings();

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

    // Merge updates (frontend already stripped unchanged masked keys)
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
      vendors: {
        ...currentSettings.vendors,
        ...updates.vendors,
      },
      extraction: {
        ...currentSettings.extraction,
        ...updates.extraction,
      },
      processing: updates.processing ? ({
        ...currentSettings.processing,
        ...updates.processing,
        text: {
          ...currentSettings.processing?.text,
          ...updates.processing?.text,
        },
        url: {
          ...currentSettings.processing?.url,
          ...updates.processing?.url,
        },
        image: {
          ...currentSettings.processing?.image,
          ...updates.processing?.image,
        },
        audio: {
          ...currentSettings.processing?.audio,
          ...updates.processing?.audio,
        },
        video: {
          ...currentSettings.processing?.video,
          ...updates.processing?.video,
        },
        pdf: {
          ...currentSettings.processing?.pdf,
          ...updates.processing?.pdf,
        },
      } as UserSettings['processing']) : currentSettings.processing,
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
    log.error({ err: error }, 'update settings failed');
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
    log.error({ err: error }, 'reset settings failed');
    return NextResponse.json(
      { error: 'Failed to reset settings' },
      { status: 500 }
    );
  }
}
