import { NextRequest, NextResponse } from 'next/server';
import { togglePinFile } from '@/lib/db/pins';
import { notificationService } from '@/lib/notifications/notification-service';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiPin' });

export const runtime = 'nodejs';

/**
 * POST /api/library/pin
 * Toggle pin state for a file
 */
export async function POST(request: NextRequest) {
  try {
    const { path } = await request.json();

    if (!path || typeof path !== 'string') {
      return NextResponse.json(
        { error: 'Path is required' },
        { status: 400 }
      );
    }

    const isPinned = togglePinFile(path);

    log.info({ path, isPinned }, 'toggled pin state');

    // Notify all clients about pin change
    notificationService.notify({
      type: 'pin-changed',
      path,
      timestamp: new Date().toISOString(),
    });

    return NextResponse.json({ isPinned });
  } catch (error) {
    log.error({ err: error }, 'toggle pin failed');
    return NextResponse.json(
      { error: 'Failed to toggle pin' },
      { status: 500 }
    );
  }
}
