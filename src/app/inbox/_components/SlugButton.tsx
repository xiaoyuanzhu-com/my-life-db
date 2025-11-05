'use client';

import { useState } from 'react';

export function SlugButton({ inboxId }: { inboxId: string }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onClick = async () => {
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch(`/api/inbox/${inboxId}/reenrich?stage=slug`, {
        method: 'POST',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || res.statusText);
      }

      const data = await res.json();
      const action = Array.isArray(data?.actions)
        ? data.actions.find((entry: any) => entry?.stage === 'slug')
        : null;
      const taskId = action?.taskId ?? data?.taskId;
      setMessage(taskId ? `Slug queued (task ${taskId})` : 'Slug queued');
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
        title="Generate slug from digest content"
      >
        {loading ? 'Queuing…' : 'Slug'}
      </button>
      {message && <span className="text-xs text-muted-foreground">{message}</span>}
    </div>
  );
}
