/**
 * Format timestamp for chat-like display
 * - Today: "16:04"
 * - Yesterday: "Yesterday 23:10"
 * - Older: "10/16 09:33"
 */
export function formatTimestamp(timestamp: number | string | Date): string {
  const date = new Date(timestamp);
  const now = new Date();

  // Reset time parts to compare dates only
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  // Format time as HH:mm
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  // Today: just time
  if (targetDate.getTime() === today.getTime()) {
    return timeStr;
  }

  // Yesterday: "Yesterday HH:mm"
  if (targetDate.getTime() === yesterday.getTime()) {
    return `Yesterday ${timeStr}`;
  }

  // Older: "MM/DD HH:mm"
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${month}/${day} ${timeStr}`;
}
