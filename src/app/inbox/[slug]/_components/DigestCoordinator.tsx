'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import type { InboxDigestScreenshot, InboxDigestSlug } from '@/lib/inbox/digestArtifacts';
import type { InboxStatusView } from '@/lib/inbox/statusView';
import { cn } from '@/lib/utils';
import { DigestProgress } from './DigestProgress';

const STAGES = [
  { key: 'crawl', label: 'Crawl', taskType: 'digest_url_crawl' },
  { key: 'summary', label: 'Summary', taskType: 'digest_url_summary' },
  { key: 'tagging', label: 'Tagging', taskType: 'digest_url_tagging' },
  { key: 'slug', label: 'Slug', taskType: 'digest_url_slug' },
] as const;

type StageName = typeof STAGES[number]['key'];
type StageStatus = 'to-do' | 'in-progress' | 'success' | 'failed';

interface DigestCoordinatorProps {
  inboxId: string;
  type: string;
  initialSummary: string | null;
  initialTags: string[] | null;
  initialScreenshot: InboxDigestScreenshot | null;
  initialSlug: InboxDigestSlug | null;
  initialStatus: InboxStatusView | null;
}

interface DigestResponse {
  summary?: string | null;
  tags?: string[] | null;
  screenshot?: InboxDigestScreenshot | null;
  slug?: InboxDigestSlug | null;
  status?: InboxStatusView | null;
  error?: string;
}

const createDefaultStageState = (): Record<StageName, boolean> => ({
  crawl: false,
  summary: false,
  tagging: false,
  slug: false,
});

export function DigestCoordinator({
  inboxId,
  type,
  initialSummary,
  initialTags,
  initialScreenshot,
  initialSlug,
  initialStatus,
}: DigestCoordinatorProps) {
  const [summary, setSummary] = useState<string | null>(initialSummary);
  const [tags, setTags] = useState<string[] | null>(initialTags);
  const [screenshot, setScreenshot] = useState<InboxDigestScreenshot | null>(initialScreenshot);
  const [slug, setSlug] = useState<InboxDigestSlug | null>(initialSlug);
  const [status, setStatus] = useState<InboxStatusView | null>(initialStatus);
  const [isPipelineActive, setIsPipelineActive] = useState(false);
  const [triggeredStages, setTriggeredStages] = useState<Record<StageName, boolean>>(createDefaultStageState());
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [isDigestButtonBusy, setIsDigestButtonBusy] = useState(false);

  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const loadDigest = useCallback(async (): Promise<DigestResponse> => {
    const res = await fetch(`/api/inbox/${inboxId}/digest`, { cache: 'no-store' });
    if (!res.ok) {
      const fallback = await res.json().catch(() => ({}));
      throw new Error((fallback as { error?: string }).error || res.statusText);
    }
    return (await res.json()) as DigestResponse;
  }, [inboxId]);

  const refreshDigest = useCallback(async () => {
    try {
      const data = await loadDigest();
      if (!isMountedRef.current) return;
      setSummary(data.summary ?? null);
      setTags(Array.isArray(data.tags) ? data.tags : null);
      setScreenshot(data.screenshot ?? null);
      setSlug(data.slug ?? null);
      setStatus(data.status ?? null);
      setPollError(null);
    } catch (error) {
      if (!isMountedRef.current) return;
      setPollError(error instanceof Error ? error.message : String(error));
    }
  }, [loadDigest]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        await refreshDigest();
      } catch {
        // handled inside refreshDigest
      }
      if (!cancelled) {
        pollTimer = setTimeout(poll, 5000);
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [refreshDigest]);

  const triggerStage = useCallback(async (stage: StageName) => {
    setTriggeredStages(prev => ({ ...prev, [stage]: true }));
    setPipelineError(null);
    try {
      const res = await fetch(`/api/inbox/${inboxId}/reenrich?stage=${stage}`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || res.statusText);
      }
      await refreshDigest();
    } catch (error) {
      if (!isMountedRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setPipelineError(`Failed to queue ${stage} stage: ${message}`);
      setTriggeredStages(prev => ({ ...prev, [stage]: false }));
      setIsPipelineActive(false);
      throw error;
    }
  }, [inboxId, refreshDigest]);

  const stageStatusMap = useMemo(() => {
    const map: Record<string, StageStatus> = {};
    status?.stages?.forEach(stage => {
      map[stage.taskType] = stage.status;
    });
    return map;
  }, [status]);

  useEffect(() => {
    if (!isPipelineActive) {
      return;
    }

    const crawlStatus = stageStatusMap['digest_url_crawl'];
    const summaryStatus = stageStatusMap['digest_url_summary'];
    const taggingStatus = stageStatusMap['digest_url_tagging'];
    const slugStatus = stageStatusMap['digest_url_slug'];

    if (crawlStatus === 'failed' || summaryStatus === 'failed' || taggingStatus === 'failed' || slugStatus === 'failed') {
      const failedStage = crawlStatus === 'failed'
        ? 'crawl'
        : summaryStatus === 'failed'
          ? 'summary'
          : taggingStatus === 'failed'
            ? 'tagging'
            : 'slug';
      setPipelineError(`Digest failed at ${failedStage} stage. Resolve the issue and retry.`);
      setIsPipelineActive(false);
      return;
    }

    if (!triggeredStages.summary && crawlStatus === 'success') {
      triggerStage('summary').catch(() => {});
      return;
    }

    if (!triggeredStages.tagging && summaryStatus === 'success') {
      triggerStage('tagging').catch(() => {});
      return;
    }

    if (!triggeredStages.slug && taggingStatus === 'success') {
      triggerStage('slug').catch(() => {});
      return;
    }

    if (slugStatus === 'success') {
      setIsPipelineActive(false);
      setTriggeredStages(createDefaultStageState());
    }
  }, [isPipelineActive, stageStatusMap, triggeredStages, triggerStage]);

  const progressStages = useMemo(
    () =>
      STAGES.map(stage => ({
        key: stage.key,
        label: stage.label,
        status: stageStatusMap[stage.taskType] ?? 'to-do',
      })),
    [stageStatusMap]
  );

  const handleDigestClick = useCallback(async () => {
    setIsDigestButtonBusy(true);
    setPipelineError(null);
    setTriggeredStages(createDefaultStageState());
    setIsPipelineActive(true);
    try {
      await triggerStage('crawl');
    } catch {
      // Error already handled inside triggerStage
    } finally {
      if (isMountedRef.current) {
        setIsDigestButtonBusy(false);
      }
    }
  }, [triggerStage]);

  return (
    <div className="space-y-6">
      <DigestProgress
        stages={progressStages}
        action={
          type === 'url' ? (
            <button
              type="button"
              onClick={handleDigestClick}
              disabled={isDigestButtonBusy || isPipelineActive}
              className={cn(
                'text-xs font-medium rounded px-3 py-1 border transition-colors',
                (isDigestButtonBusy || isPipelineActive)
                  ? 'opacity-70 cursor-not-allowed'
                  : 'hover:bg-accent'
              )}
              title="Run crawl -> summary -> tagging -> slug in order"
            >
              {(isDigestButtonBusy || isPipelineActive) ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Processing...
                </span>
              ) : (
                'Digest'
              )}
            </button>
          ) : null
        }
        message={pipelineError ?? (pollError ? `Auto refresh issue: ${pollError}` : null)}
      />

      <section className="bg-card rounded-lg border">
        <div className="border-b border-border px-6 py-4">
          <h2 className="text-sm font-semibold text-foreground">Summary</h2>
          <p className="text-xs text-muted-foreground">AI-generated digest summary</p>
        </div>
        <div className="p-6">
          {summary ? (
            <div className="text-sm whitespace-pre-wrap break-words leading-7 text-foreground">
              {summary}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">Summary not available yet.</p>
          )}
        </div>
      </section>

      <section className="bg-card rounded-lg border">
        <div className="border-b border-border px-6 py-4">
          <h2 className="text-sm font-semibold text-foreground">Tags</h2>
          <p className="text-xs text-muted-foreground">Quick keywords generated from the content</p>
        </div>
        <div className="p-6">
          {tags && tags.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="text-xs font-medium px-2 py-1 rounded-full border border-border bg-muted text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">Tags not generated yet.</p>
          )}
        </div>
      </section>

      <section className="bg-card rounded-lg border">
        <div className="border-b border-border px-6 py-4">
          <h2 className="text-sm font-semibold text-foreground">Slug</h2>
          <p className="text-xs text-muted-foreground">Generated handle for this URL digest</p>
        </div>
        <div className="p-6 space-y-2">
          {slug?.slug ? (
            <>
              <code className="inline-block rounded bg-muted px-2 py-1 text-xs font-mono text-foreground">
                {slug.slug}
              </code>
              {slug.title && (
                <p className="text-xs text-muted-foreground">
                  Title hint: <span className="text-foreground">{slug.title}</span>
                </p>
              )}
              {slug.source && (
                <p className="text-xs text-muted-foreground">
                  Source: <span className="text-foreground">{slug.source}</span>
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground italic">Slug not generated yet.</p>
          )}
        </div>
      </section>

      <section className="bg-card rounded-lg border">
        <div className="border-b border-border px-6 py-4">
          <h2 className="text-sm font-semibold text-foreground">Screenshot</h2>
          <p className="text-xs text-muted-foreground">
            {screenshot ? screenshot.filename : 'Captured image will appear after crawl'}
          </p>
        </div>
        <div className="p-6">
          {screenshot ? (
            <div
              className="relative w-full overflow-hidden rounded-md border border-border bg-muted"
              style={{ minHeight: 240 }}
            >
              <Image
                src={screenshot.src}
                alt="Captured page screenshot"
                fill
                sizes="100vw"
                className="object-contain"
                priority={false}
                unoptimized
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic">Screenshot not available yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}
