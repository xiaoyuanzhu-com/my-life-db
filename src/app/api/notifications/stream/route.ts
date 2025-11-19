// Server-Sent Events (SSE) endpoint for real-time notifications
import { NextRequest } from 'next/server';
import { notificationService, type NotificationEvent } from '@/lib/notifications/notification-service';
import { getLogger } from '@/lib/log/logger';

// Force Node.js runtime (SSE requires streaming)
export const runtime = 'nodejs';

const log = getLogger({ module: 'ApiNotificationsStream' });

/**
 * GET /api/notifications/stream
 * Server-Sent Events endpoint for real-time notifications
 */
export async function GET(request: NextRequest) {
  log.info('SSE connection established');

  // Create a ReadableStream for SSE
  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection message
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));

      // Subscribe to notifications
      const unsubscribe = notificationService.subscribe((event: NotificationEvent) => {
        try {
          // Format as SSE message
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
          log.debug({ event }, 'Sent SSE event to client');
        } catch (error) {
          log.error({ err: error }, 'Failed to send SSE event');
        }
      });

      // Handle connection close
      request.signal.addEventListener('abort', () => {
        log.info('SSE connection closed');
        unsubscribe();
        controller.close();
      });

      // Send periodic heartbeat to keep connection alive (every 30s)
      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch (error) {
          log.error({ err: error }, 'Heartbeat failed');
          clearInterval(heartbeatInterval);
        }
      }, 30000);

      // Clean up on close
      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeatInterval);
      });
    },
  });

  // Return SSE response
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable buffering for nginx
    },
  });
}
