import { useEffect, useState, useCallback } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Loader2,
  SkipForward,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { cn } from '~/lib/utils';
import type { FileWithDigests, DigestSummary } from '~/types/file-card';
import { getDigestRenderer } from './digest-renderers';

type DigestStageStatus = 'to-do' | 'in-progress' | 'success' | 'failed' | 'skipped';

interface DigestStage {
  key: string;
  label: string;
  status: DigestStageStatus;
  content: string | null;
  sqlarName: string | null;
  error: string | null;
}

interface AudioSyncProps {
  currentTime: number;
  onSeek: (time: number) => void;
}

interface DigestsPanelProps {
  file: FileWithDigests;
  className?: string;
  /** Audio sync props for speech-recognition renderer */
  audioSync?: AudioSyncProps;
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

function StatusIcon({ status }: { status: DigestStageStatus }): React.ReactElement {
  switch (status) {
    case 'success':
      return <CheckCircle2 className="h-4 w-4 text-muted-foreground" />;
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

export function DigestsPanel({ file, className, audioSync }: DigestsPanelProps) {
  const [stages, setStages] = useState<DigestStage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [resettingDigester, setResettingDigester] = useState<string | null>(null);
  // Toggle for showing cleaned transcript instead of raw speech-recognition
  const [showCleanedTranscript, setShowCleanedTranscript] = useState(true);

  const fetchDigests = useCallback(async () => {
    try {
      const response = await fetch(`/api/library/file-info?path=${encodeURIComponent(file.path)}`);
      if (!response.ok) throw new Error('Failed to fetch digests');

      const data = await response.json();

      const fetchedStages = (data.digests || []).map((d: { digester: string; status: string; content: string | null; sqlarName: string | null; error: string | null }) => ({
        key: d.digester,
        label: formatDigesterLabel(d.digester),
        status: mapApiStatus(d.status),
        content: d.content,
        sqlarName: d.sqlarName ?? null,
        error: d.error,
      }));
      setStages(fetchedStages);
      return fetchedStages;
    } catch {
      // Fall back to file.digests if API fails
      const fallbackStages = file.digests.map((d) => ({
        key: d.type,
        label: formatDigesterLabel(d.type),
        status: mapStatus(d.status),
        content: d.content,
        sqlarName: d.sqlarName ?? null,
        error: d.error,
      }));
      setStages(fallbackStages);
      return fallbackStages;
    }
  }, [file.path, file.digests]);

  // Initial fetch
  useEffect(() => {
    let cancelled = false;

    async function initialFetch() {
      setIsLoading(true);
      await fetchDigests();
      if (!cancelled) setIsLoading(false);
    }

    initialFetch();
    return () => { cancelled = true; };
  }, [fetchDigests]);

  // Poll while any digest is in-progress
  useEffect(() => {
    const hasInProgress = stages.some((s) => s.status === 'in-progress');
    if (!hasInProgress) return;

    const interval = setInterval(() => {
      fetchDigests();
    }, 2000);

    return () => clearInterval(interval);
  }, [stages, fetchDigests]);

  const handleResetDigest = useCallback(async (digester: string) => {
    setResettingDigester(digester);

    try {
      const response = await fetch(`/api/digest/${file.path}?digester=${encodeURIComponent(digester)}`, {
        method: 'POST',
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to reset ${digester}`);
      }

      // Refresh digests after reset
      await fetchDigests();
    } catch (err) {
      console.error('Failed to reset digest:', err);
    } finally {
      setResettingDigester(null);
    }
  }, [file.path, fetchDigests]);

  const completedCount = stages.filter((s) => s.status === 'success').length;
  const totalCount = stages.length;
  const hasFailures = stages.some((s) => s.status === 'failed');

  return (
    <div className={cn('flex flex-col h-full bg-[#fffffe] [@media(prefers-color-scheme:dark)]:bg-[#1e1e1e] rounded-lg overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          {totalCount > 0 && (
            <button
              onClick={() => stages.forEach((s) => handleResetDigest(s.key))}
              disabled={stages.some((s) => s.status === 'in-progress') || resettingDigester !== null}
              className="flex-shrink-0 p-0 bg-transparent border-none outline-none cursor-pointer hover:opacity-70 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              title="Re-run all digests"
            >
              {hasFailures && completedCount === 0 ? (
                <XCircle className="h-4 w-4 text-muted-foreground" />
              ) : hasFailures ? (
                <AlertCircle className="h-4 w-4 text-muted-foreground" />
              ) : completedCount === totalCount ? (
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Circle className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          )}
          <h3 className="text-sm font-semibold">Digests</h3>
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
            {stages.map((stage) => {
              // Skip speech-recognition-cleanup as it's rendered via toggle on speech-recognition
              if (stage.key === 'speech-recognition-cleanup') {
                return null;
              }

              // Check if this is speech-recognition and cleanup is available
              const cleanupStage = stage.key === 'speech-recognition'
                ? stages.find((s) => s.key === 'speech-recognition-cleanup' && s.status === 'success')
                : undefined;
              const hasCleanup = cleanupStage !== undefined;

              return (
                <div
                  key={stage.key}
                  className={cn(
                    'p-3 rounded-lg border max-h-64 overflow-y-auto',
                    stage.status === 'failed' && 'border-destructive/30 bg-destructive/10',
                    stage.status === 'success' && 'border-border bg-muted/30',
                    stage.status === 'in-progress' && 'border-primary/20 bg-primary/5',
                    (stage.status === 'to-do' || stage.status === 'skipped') && 'border-border bg-muted/50'
                  )}
                >
                  <div className="flex items-center gap-2">
                    {(() => {
                      // Determine which digest to show status/re-run for
                      const useCleanup = stage.key === 'speech-recognition' && hasCleanup && showCleanedTranscript;
                      const activeKey = useCleanup ? 'speech-recognition-cleanup' : stage.key;
                      const activeStatus = useCleanup ? cleanupStage!.status : stage.status;
                      const isResetting = resettingDigester === activeKey;

                      if (isResetting) {
                        return <Loader2 className="h-4 w-4 text-primary animate-spin" />;
                      }

                      return (
                        <button
                          onClick={() => handleResetDigest(activeKey)}
                          className="flex-shrink-0 p-0 bg-transparent border-none outline-none cursor-pointer hover:opacity-70 transition-opacity"
                          title="Click to re-run"
                        >
                          <StatusIcon status={activeStatus} />
                        </button>
                      );
                    })()}
                    <span className="text-sm font-medium">
                      {stage.key === 'speech-recognition' && hasCleanup && showCleanedTranscript
                        ? 'Speech Recognition Cleanup'
                        : stage.label}
                    </span>
                    {/* Toggle for cleaned vs raw transcript */}
                    {hasCleanup && (
                      <button
                        onClick={() => setShowCleanedTranscript((v) => !v)}
                        className={cn(
                          'ml-auto flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors',
                          showCleanedTranscript
                            ? 'bg-primary/10 text-primary'
                            : 'bg-muted text-muted-foreground hover:bg-muted/80'
                        )}
                        title={showCleanedTranscript ? 'Click to show raw transcript' : 'Click to show cleaned transcript'}
                      >
                        <Sparkles className="h-3 w-3" />
                        <span>{showCleanedTranscript ? 'Cleaned' : 'Raw'}</span>
                      </button>
                    )}
                  </div>
                  {stage.error && (
                    <p className="mt-1 text-xs text-destructive">
                      {stage.error}
                    </p>
                  )}
                  {(() => {
                    // For speech-recognition, decide which content to show based on toggle
                    const useCleanup = stage.key === 'speech-recognition' && hasCleanup && showCleanedTranscript;
                    const rendererKey = useCleanup ? 'speech-recognition-cleanup' : stage.key;
                    const contentToRender = useCleanup ? cleanupStage!.content : stage.content;

                    const Renderer = getDigestRenderer(rendererKey);
                    // Pass audioSync to speech-recognition and speech-recognition-cleanup renderers
                    const extraProps = (stage.key === 'speech-recognition') && audioSync
                      ? { currentTime: audioSync.currentTime, onSeek: audioSync.onSeek }
                      : {};
                    return (
                      <Renderer
                        content={contentToRender}
                        sqlarName={stage.sqlarName}
                        filePath={file.path}
                        {...extraProps}
                      />
                    );
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
