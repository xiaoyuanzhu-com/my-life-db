'use client';

import { useState } from 'react';

export function TaggingButton({ itemId }: { itemId: string }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onClick = async () => {
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch(`/api/digest/inbox/${itemId}?step=tags`, {
        method: 'POST',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || res.statusText);
      }

      setMessage('Tagging queued');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setMessage(`Failed: ${errorMessage}`);
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
        title="Generate tags for this URL"
      >
        {loading ? 'Queuing...' : 'Tag'}
      </button>
      {message && <span className="text-xs text-muted-foreground">{message}</span>}
    </div>
  );
}
