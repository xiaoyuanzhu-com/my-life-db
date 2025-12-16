import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Loader2,
  SkipForward,
  XCircle,
} from 'lucide-react';
import { cn } from '~/lib/utils';
import type { FileWithDigests, DigestSummary } from '~/types/file-card';

type DigestStageStatus = 'to-do' | 'in-progress' | 'success' | 'failed' | 'skipped';

interface DigestStage {
  key: string;
  label: string;
  status: DigestStageStatus;
  content: string | null;
  error: string | null;
}

interface DigestsPanelProps {
  file: FileWithDigests;
  className?: string;
}

function mapStatus(status: DigestSummary['status']): DigestStageStatus {
  switch (status) {
    case 'pending':
      return 'to-do';
    case 'processing':
      return 'in-progress';
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'to-do';
  }
}

function mapApiStatus(status: string): DigestStageStatus {
  switch (status) {
    case 'todo':
      return 'to-do';
    case 'in-progress':
      return 'in-progress';
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'to-do';
  }
}

function formatDigesterLabel(digester: string): string {
  return digester
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function statusIcon(status: DigestStageStatus): React.ReactElement {
  switch (status) {
    case 'success':
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-red-500" />;
    case 'in-progress':
      return <Loader2 className="h-4 w-4 text-primary animate-spin" />;
    case 'skipped':
      return <SkipForward className="h-4 w-4 text-muted-foreground" />;
    default:
      return <Circle className="h-4 w-4 text-muted-foreground" />;
  }
}

function DigestContent({ content }: { content: string | null }) {
  if (!content) return null;

  // Try to parse as JSON for structured content (tags, etc.)
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return (
        <div className="flex flex-wrap gap-1 mt-1">
          {parsed.map((item, i) => (
            <span
              key={i}
              className="px-2 py-0.5 text-xs bg-muted rounded-full"
            >
              {String(item)}
            </span>
          ))}
        </div>
      );
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return (
        <pre className="mt-1 text-xs text-muted-foreground overflow-auto max-h-32 p-2 bg-muted rounded">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    }
  } catch {
    // Not JSON, display as text
  }

  // Plain text content
  return (
    <p className="mt-1 text-sm text-muted-foreground line-clamp-3">
      {content}
    </p>
  );
}

export function DigestsPanel({ file, className }: DigestsPanelProps) {
  const [stages, setStages] = useState<DigestStage[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch digests from API (file.digests may be empty for performance)
  useEffect(() => {
    let cancelled = false;

    async function fetchDigests() {
      setIsLoading(true);
      try {
        const response = await fetch(`/api/library/file-info?path=${encodeURIComponent(file.path)}`);
        if (!response.ok) throw new Error('Failed to fetch digests');

        const data = await response.json();
        if (cancelled) return;

        const fetchedStages = (data.digests || []).map((d: { digester: string; status: string; content: string | null; error: string | null }) => ({
          key: d.digester,
          label: formatDigesterLabel(d.digester),
          status: mapApiStatus(d.status),
          content: d.content,
          error: d.error,
        }));
        setStages(fetchedStages);
      } catch {
        // Fall back to file.digests if API fails
        if (cancelled) return;
        const fallbackStages = file.digests.map((d) => ({
          key: d.type,
          label: formatDigesterLabel(d.type),
          status: mapStatus(d.status),
          content: d.content,
          error: d.error,
        }));
        setStages(fallbackStages);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchDigests();
    return () => { cancelled = true; };
  }, [file.path, file.digests]);

  const completedCount = stages.filter((s) => s.status === 'success').length;
  const totalCount = stages.length;
  const hasFailures = stages.some((s) => s.status === 'failed');

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div>
          <h3 className="text-sm font-semibold">Digests</h3>
          <p className="text-xs text-muted-foreground">
            {totalCount === 0
              ? 'No digests yet'
              : `${completedCount}/${totalCount} complete`}
          </p>
        </div>
      </div>

      {/* Digest list */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Loader2 className="h-8 w-8 mb-2 animate-spin" />
            <p className="text-sm">Loading digests...</p>
          </div>
        ) : stages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Circle className="h-8 w-8 mb-2" />
            <p className="text-sm">No digests available</p>
          </div>
        ) : (
          <div className="space-y-3">
            {stages.map((stage) => (
              <div
                key={stage.key}
                className={cn(
                  'p-3 rounded-lg border',
                  stage.status === 'failed' && 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/50',
                  stage.status === 'success' && 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/50',
                  stage.status === 'in-progress' && 'border-primary/20 bg-primary/5',
                  (stage.status === 'to-do' || stage.status === 'skipped') && 'border-border bg-muted/50'
                )}
              >
                <div className="flex items-center gap-2">
                  {statusIcon(stage.status)}
                  <span className="text-sm font-medium">{stage.label}</span>
                </div>
                {stage.error && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {stage.error}
                  </p>
                )}
                <DigestContent content={stage.content} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer with warning if failures */}
      {hasFailures && (
        <div className="px-4 py-2 border-t bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400 text-xs flex items-center gap-1">
          <AlertCircle className="h-3.5 w-3.5" />
          Some digests failed.
        </div>
      )}
    </div>
  );
}
