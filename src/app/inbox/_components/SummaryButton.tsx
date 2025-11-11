'use client';

import { useState } from 'react';

export function SummaryButton({ itemId }: { itemId: string }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onClick = async () => {
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch(`/api/inbox/${itemId}/reenrich?stage=summary`, {
        method: 'POST',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || res.statusText);
      }

      const data = await res.json();
      const taskId = data?.actions?.find((action: any) => action.stage === 'summary')?.taskId ?? data?.taskId;
      setMessage(taskId ? `Summary queued (task ${taskId})` : 'Summary queued');
    } catch (error: any) {
      setMessage(`Failed: ${error?.message || 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onClick}
        disabled={loading}
        className={`text-xs font-medium rounded px-3 py-1 border ${loading ? 'opacity-70 cursor-not-allowed' : 'hover:bg-accent'}`}
        title="Generate AI summary for this URL"
      >
        {loading ? 'Queuing…' : 'Summarize'}
      </button>
      {message && <span className="text-xs text-muted-foreground">{message}</span>}
    </div>
  );
}
