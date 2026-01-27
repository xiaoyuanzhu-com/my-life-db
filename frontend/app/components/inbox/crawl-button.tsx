import { useState } from 'react';
import { api } from '~/lib/api';

export function CrawlButton({ itemId }: { itemId: string }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onClick = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await api.post(`/api/digest/file/inbox/${itemId}?step=crawl`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || res.statusText);
      }
      setMessage('Crawl queued');
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : 'Unknown error';
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
        title="Trigger crawl for this URL"
      >
        {loading ? 'Queuing...' : 'Crawl'}
      </button>
      {message && (
        <span className="text-xs text-muted-foreground">{message}</span>
      )}
    </div>
  );
}
