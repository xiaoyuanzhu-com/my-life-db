import { useState } from 'react';

interface IndexButtonProps {
  itemId: string;
}

export function IndexButton({ itemId }: IndexButtonProps) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onClick = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/digest/file/inbox/${itemId}?step=index`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error || res.statusText);
      }
      setMessage('Indexing queued');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setMessage(`Failed: ${message}`);
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
      >
        {loading ? 'Indexing...' : 'Index'}
      </button>
      {message && <span className="text-xs text-muted-foreground">{message}</span>}
    </div>
  );
}
