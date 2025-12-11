import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import type { InboxDigestScreenshot, InboxDigestSlug, DigestStatusSummary as DigestStatusView, DigestStageStatusSummary as DigestStageStatus } from '~/types';
import { cn } from '~/lib/utils';
import { DigestProgress } from './digest-progress';

type StageStatusName = DigestStageStatus['status'];

interface DigesterInfo {
  name: string;
  label: string;
  outputs: string[];
}

const log = (message: string, payload?: unknown) => {
  if (payload === undefined) {
    console.info(`[DigestCoordinator] ${message}`);
  } else {
    console.info(`[DigestCoordinator] ${message}: ${JSON.stringify(payload)}`);
  }
};

interface DigestCoordinatorProps {
  itemId: string;
  initialSummary: string | null;
  initialTags: string[] | null;
  initialScreenshot: InboxDigestScreenshot | null;
  initialSlug: InboxDigestSlug | null;
  initialStatus: DigestStatusView | null;
}

interface InboxDetailResponse {
  primaryText?: string | null;
  digest?: {
    summary?: string | null;
    tags?: string[] | null;
    screenshot?: InboxDigestScreenshot | null;
    slug?: InboxDigestSlug | null;
  };
}

interface DigestStatusResponse {
  status: DigestStatusView | null;
}

interface DigestersResponse {
  digesters: DigesterInfo[];
}

export function DigestCoordinator({
  itemId,
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
  const [status, setStatus] = useState<DigestStatusView | null>(initialStatus);
  const [digesters, setDigesters] = useState<DigesterInfo[]>([]);
  const [isDigestButtonBusy, setIsDigestButtonBusy] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Use ref to store itemId to avoid dependency issues
  const itemIdRef = useRef(itemId);
  useEffect(() => {
    itemIdRef.current = itemId;
  }, [itemId]);

  // Fetch digesters on mount
  useEffect(() => {
    async function loadDigesters() {
      try {
        const res = await fetch('/api/digest/digesters', { cache: 'no-store' });
        if (res.ok) {
          const data = (await res.json()) as DigestersResponse;
          setDigesters(data.digesters);
        }
      } catch (error) {
        log('failed to load digesters', error);
      }
    }
    loadDigesters();
  }, []);

  const fetchContent = useCallback(async () => {
    const currentId = itemIdRef.current;
    log('fetchContent start', { itemId: currentId });
    const res = await fetch(`/api/inbox/${currentId}`, { cache: 'no-store' });
    if (!res.ok) {
      const fallback = await res.json().catch(() => ({}));
      throw new Error((fallback as { error?: string }).error || res.statusText);
    }
    const payload = (await res.json()) as InboxDetailResponse;
    log('fetchContent success');
    return payload;
  }, []);

  const fetchStatus = useCallback(async () => {
    const currentId = itemIdRef.current;
    log('fetchStatus start', { itemId: currentId });
    const res = await fetch(`/api/digest/inbox/${currentId}`, { cache: 'no-store' });
    if (!res.ok) {
      const fallback = await res.json().catch(() => ({}));
      throw new Error((fallback as { error?: string }).error || res.statusText);
    }
    const payload = (await res.json()) as DigestStatusResponse;
    log('fetchStatus success', {
      overall: payload.status?.overall ?? null,
      stageCount: payload.status?.stages?.length ?? 0,
    });
    return payload;
  }, []);

  const refreshDigest = useCallback(async () => {
    try {
      const [content, statusPayload] = await Promise.all([fetchContent(), fetchStatus()]);
      if (!isMountedRef.current) return;

      const digest = content.digest ?? {};
      log('refreshDigest update', {
        digestSummary: digest.summary,
        digestTagsCount: Array.isArray(digest.tags) ? digest.tags.length : null,
        hasScreenshot: Boolean(digest.screenshot),
        slug: digest.slug?.slug ?? null,
        stageCount: statusPayload.status?.stages?.length ?? 0,
      });
      setSummary(digest.summary ?? null);
      setTags(Array.isArray(digest.tags) ? digest.tags : null);
      setScreenshot(digest.screenshot ?? null);
      setSlug(digest.slug ?? null);
      setStatus(statusPayload.status ?? null);
      setPollError(null);
    } catch (error) {
      if (!isMountedRef.current) return;
      setPollError(error instanceof Error ? error.message : String(error));
    }
  }, [fetchContent, fetchStatus]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      await refreshDigest();
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

  const pipelineActive = useMemo(() => {
    return status?.stages?.some(stage => stage.status === 'in-progress') ?? false;
  }, [status]);

  const hasFailures = Boolean(status?.hasFailures);
  const failedStage = useMemo(() => status?.stages?.find(stage => stage.status === 'failed'), [status]);

  // Build progress stages from actual digest status, filtered to non-skipped stages
  const progressStages = useMemo(() => {
    if (!status?.stages || status.stages.length === 0) {
      return [];
    }

    // Filter out skipped stages and map to progress format
    return status.stages
      .filter(stage => stage.status !== 'skipped')
      .map(stage => {
        // Find digester label
        const digesterInfo = digesters.find(d =>
          d.name === stage.digester || d.outputs.includes(stage.digester)
        );
        const label = digesterInfo?.label ?? formatDigesterName(stage.digester);

        return {
          key: stage.digester,
          label,
          status: stage.status as StageStatusName,
        };
      });
  }, [status, digesters]);

  const message = useMemo(() => {
    if (pipelineError) return pipelineError;
    if (pollError) return `Auto refresh issue: ${pollError}`;
    if (hasFailures && failedStage) {
      const digesterInfo = digesters.find(d =>
        d.name === failedStage.digester || d.outputs.includes(failedStage.digester)
      );
      const label = digesterInfo?.label ?? formatDigesterName(failedStage.digester);
      return `Digest failed at ${label}. Resolve the issue and retry.`;
    }
    return null;
  }, [failedStage, hasFailures, pipelineError, pollError, digesters]);

  const handleDigestClick = useCallback(async () => {
    setIsDigestButtonBusy(true);
    setPipelineError(null);
    setSummary(null);
    setTags(null);
    setScreenshot(null);
    setSlug(null);
    log('handleDigestClick triggered');
    try {
      const res = await fetch(`/api/digest/inbox/${itemIdRef.current}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || res.statusText);
      }
      log('workflow started, refreshing after delay');
      // Add a small delay before refreshing to give backend time to update
      await new Promise(resolve => setTimeout(resolve, 500));
      await refreshDigest();
    } catch (error) {
      if (!isMountedRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setPipelineError(`Failed to start digest workflow: ${message}`);
    } finally {
      if (isMountedRef.current) {
        setIsDigestButtonBusy(false);
      }
    }
  }, [refreshDigest]);

  return (
    <div className="space-y-6">
      <DigestProgress
        stages={progressStages}
        action={
          <button
            type="button"
            onClick={handleDigestClick}
            disabled={isDigestButtonBusy || pipelineActive}
            className={cn(
              'text-xs font-medium rounded px-3 py-1 border transition-colors',
              (isDigestButtonBusy || pipelineActive)
                ? 'opacity-70 cursor-not-allowed'
                : 'hover:bg-accent'
            )}
            title="Run all applicable digesters"
          >
            {(isDigestButtonBusy || pipelineActive) ? (
              <span className="flex items-center gap-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Processing...
              </span>
            ) : (
              'Digest'
            )}
          </button>
        }
        message={message}
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
          <p className="text-xs text-muted-foreground">Generated handle for this digest</p>
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
              <img
                src={screenshot.src}
                alt="Captured page screenshot"
                className="object-contain w-full h-full"
                loading="lazy"
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

/**
 * Convert digester name to human-readable format (fallback when label not available)
 */
function formatDigesterName(name: string): string {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
