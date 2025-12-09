import type { LoaderFunctionArgs } from "react-router";
import { notificationService, type NotificationEvent } from "~/lib/notifications/notification-service";
import { getLogger } from "~/lib/log/logger";

const log = getLogger({ module: "ApiNotificationsStream" });

export async function loader({ request }: LoaderFunctionArgs) {
  log.info("SSE connection established");

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));

      const unsubscribe = notificationService.subscribe((event: NotificationEvent) => {
        try {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(data));
          log.debug({ event }, "Sent SSE event to client");
        } catch (error) {
          log.error({ err: error }, "Failed to send SSE event");
        }
      });

      request.signal.addEventListener("abort", () => {
        log.info("SSE connection closed");
        unsubscribe();
        controller.close();
      });

      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch (error) {
          log.error({ err: error }, "Heartbeat failed");
          clearInterval(heartbeatInterval);
        }
      }, 30000);

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeatInterval);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
