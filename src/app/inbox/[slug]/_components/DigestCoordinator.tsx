'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import type { InboxDigestScreenshot, InboxDigestSlug } from '@/types';
import type { InboxStatusView } from '@/lib/inbox/statusView';
import { cn } from '@/lib/utils';
import { DigestProgress } from './DigestProgress';

const STAGES = [
  { key: 'crawl', label: 'Crawl', taskType: 'digest_url_crawl' },
  { key: 'summary', label: 'Summary', taskType: 'digest_url_summary' },
  { key: 'tagging', label: 'Tagging', taskType: 'digest_url_tagging' },
  { key: 'slug', label: 'Slug', taskType: 'digest_url_slug' },
] as const;

type StageStatusName = 'to-do' | 'in-progress' | 'success' | 'failed';

const log = (message: string, payload?: unknown) => {
  if (payload === undefined) {
    console.info(`[DigestCoordinator] ${message}`);
  } else {
    console.info(`[DigestCoordinator] ${message}: ${JSON.stringify(payload)}`);
  }
};

function deriveStageMap(status: InboxStatusView | null): Record<string, StageStatusName> {
  const map: Record<string, StageStatusName> = {};

  // ONLY use explicit stage states from the API
  // The done flags are for UI hints, not for determining stage status
  status?.stages?.forEach(stage => {
    map[stage.taskType] = stage.status;
    log(`deriveStageMap: from stages[] ${stage.taskType} = ${stage.status}`);
  });

  // For stages not in the API response, check if they're completed via done flags
  // But NEVER set them to 'to-do' here - let the merge logic handle that
  STAGES.forEach(stage => {
    if (map[stage.taskType]) {
      // Already have explicit status from API
      return;
    }

    // Only derive 'success' state from done flags
    // If not done, leave it undefined so merge logic can handle it properly
    const derivedSuccess =
      (stage.key === 'crawl' && status?.crawlDone) ||
      (stage.key === 'summary' && status?.summaryDone) ||
      (stage.key === 'tagging' && status?.tagsReady) ||
      (stage.key === 'slug' && status?.slugReady);

    if (derivedSuccess) {
      log(`deriveStageMap: derived ${stage.taskType} = success (done flag set)`);
      map[stage.taskType] = 'success';
    } else {
      // Don't set anything - let merge logic preserve previous state
      log(`deriveStageMap: ${stage.taskType} not in API response and not done, leaving undefined for merge`);
    }
  });

  return map;
}

function mergeStageMaps(
  previous: Record<string, StageStatusName>,
  status: InboxStatusView | null
): Record<string, StageStatusName> {
  const incoming = deriveStageMap(status);
  const merged: Record<string, StageStatusName> = { ...previous };

  STAGES.forEach(stage => {
    const taskType = stage.taskType;
    const nextState = incoming[taskType];
    const prevState = previous[taskType];

    // If incoming doesn't have this stage, keep previous state
    if (!nextState) {
      log(`merge: ${taskType} not in incoming, preserving ${prevState ?? 'to-do'}`);
      if (!prevState) {
        merged[taskType] = 'to-do';
      }
      return;
    }

    // Prevent regression: never move backwards from a terminal or progress state
    // Order: to-do < in-progress < success/failed
    if (prevState === 'success' || prevState === 'failed') {
      // Terminal states: never change
      log(`merge: ${taskType} locked at terminal state ${prevState}`);
      return;
    }

    if (prevState === 'in-progress' && nextState === 'to-do') {
      // Don't regress from in-progress to to-do
      log(`merge: ${taskType} prevented regression from in-progress to to-do`);
      return;
    }

    // Allow progression: to-do -> in-progress -> success/failed
    if (prevState !== nextState) {
      log(`merge: ${taskType} changing from ${prevState ?? 'undefined'} to ${nextState}`);
    }
    merged[taskType] = nextState;
  });

  return merged;
}

interface DigestCoordinatorProps {
  itemId: string;
  type: string;
  initialSummary: string | null;
  initialTags: string[] | null;
  initialScreenshot: InboxDigestScreenshot | null;
  initialSlug: InboxDigestSlug | null;
  initialStatus: InboxStatusView | null;
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
  status: InboxStatusView | null;
}

export function DigestCoordinator({
  itemId,
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
  const [stageStatusMap, setStageStatusMap] = useState<Record<string, StageStatusName>>(deriveStageMap(initialStatus));
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
    const res = await fetch(`/api/inbox/${currentId}/digest/status`, { cache: 'no-store' });
    if (!res.ok) {
      const fallback = await res.json().catch(() => ({}));
      throw new Error((fallback as { error?: string }).error || res.statusText);
    }
    const payload = (await res.json()) as DigestStatusResponse;
    log('fetchStatus success', {
      overall: payload.status?.overall ?? null,
      stageStatuses: payload.status?.stages?.map(stage => ({ taskType: stage.taskType, status: stage.status })) ?? [],
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
      const nextStatus = statusPayload.status ?? null;
      setStatus(nextStatus);
      setStageStatusMap(prev => {
        const merged = mergeStageMaps(prev, nextStatus);
        log(
          'stage map merged',
          STAGES.map(stage => `${stage.taskType}:${merged[stage.taskType] ?? 'to-do'}`).join(', ')
        );
        return merged;
      });
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
    const active = Object.values(stageStatusMap).some(value => value === 'in-progress');
    log('pipelineActive computed', `active=${active} | ${STAGES.map(stage => `${stage.taskType}:${stageStatusMap[stage.taskType] ?? 'to-do'}`).join(', ')}`);
    return active;
  }, [stageStatusMap]);

  const hasFailures = Boolean(status?.hasFailures);
  const failedStage = useMemo(() => status?.stages?.find(stage => stage.status === 'failed'), [status]);

  const progressStages = useMemo(() => {
    const stages = STAGES.map(stage => {
      const taskType = stage.taskType;
      const statusValue = stageStatusMap[taskType] ?? 'to-do';
      return {
        key: stage.key,
        label: stage.label,
        status: statusValue,
      };
    });
    log(
      'progressStages',
      stages.map(stage => `${stage.key}:${stage.status}`).join(', ')
    );
    return stages;
  }, [stageStatusMap]);

  const message = useMemo(() => {
    if (pipelineError) return pipelineError;
    if (pollError) return `Auto refresh issue: ${pollError}`;
    if (hasFailures && failedStage) {
      const stageMeta = STAGES.find(stage => stage.taskType === failedStage.taskType);
      const label = stageMeta?.label ?? failedStage.taskType;
      return `Digest failed at ${label}. Resolve the issue and retry.`;
    }
    return null;
  }, [failedStage, hasFailures, pipelineError, pollError]);

  const handleDigestClick = useCallback(async () => {
    setIsDigestButtonBusy(true);
    setPipelineError(null);
    setSummary(null);
    setTags(null);
    setScreenshot(null);
    setSlug(null);
    setStageStatusMap({
      digest_url_crawl: 'in-progress',
      digest_url_summary: 'to-do',
      digest_url_tagging: 'to-do',
      digest_url_slug: 'to-do',
    });
    log('handleDigestClick triggered');
    try {
      const res = await fetch(`/api/inbox/${itemIdRef.current}/digest`, { method: 'POST' });
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
          type === 'url' ? (
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
              title="Run crawl -> summary -> tagging -> slug in order"
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
          ) : null
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
