'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import type { InboxDigestScreenshot, InboxDigestSlug } from '@/types';
import type { InboxStatusView, InboxStageStatus } from '@/lib/inbox/statusView';
import { cn } from '@/lib/utils';
import { DigestProgress } from './DigestProgress';

const STAGES = [
  { key: 'crawl', label: 'Crawl', taskType: 'digest_url_crawl' },
  { key: 'summary', label: 'Summary', taskType: 'digest_url_summary' },
  { key: 'tagging', label: 'Tagging', taskType: 'digest_url_tagging' },
  { key: 'slug', label: 'Slug', taskType: 'digest_url_slug' },
] as const;

interface DigestCoordinatorProps {
  inboxId: string;
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
  const [isDigestButtonBusy, setIsDigestButtonBusy] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchContent = useCallback(async () => {
    const res = await fetch(`/api/inbox/${inboxId}`, { cache: 'no-store' });
    if (!res.ok) {
      const fallback = await res.json().catch(() => ({}));
      throw new Error((fallback as { error?: string }).error || res.statusText);
    }
    return (await res.json()) as InboxDetailResponse;
  }, [inboxId]);

  const fetchStatus = useCallback(async () => {
    const res = await fetch(`/api/inbox/${inboxId}/digest/status`, { cache: 'no-store' });
    if (!res.ok) {
      const fallback = await res.json().catch(() => ({}));
      throw new Error((fallback as { error?: string }).error || res.statusText);
    }
    return (await res.json()) as DigestStatusResponse;
  }, [inboxId]);

  const refreshDigest = useCallback(async () => {
    try {
      const [content, statusPayload] = await Promise.all([fetchContent(), fetchStatus()]);
      if (!isMountedRef.current) return;

      const digest = content.digest ?? {};
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

  const pipelineActive = useMemo(
    () => Boolean(status?.stages?.some(stage => stage.status === 'in-progress')),
    [status]
  );

  const hasFailures = Boolean(status?.hasFailures);
  const failedStage = useMemo(() => status?.stages?.find(stage => stage.status === 'failed'), [status]);

  const progressStages = useMemo(() => {
    const map = new Map<string, InboxStageStatus>();
    status?.stages?.forEach(stage => map.set(stage.taskType, stage));

    return STAGES.map(stage => {
      const stageStatus = map.get(stage.taskType);
      return {
        key: stage.key,
        label: stage.label,
        status: stageStatus?.status ?? 'to-do',
      };
    });
  }, [status]);

  const statusLabelMap: Record<string, string> = useMemo(() => {
    const fromStages = Object.fromEntries(STAGES.map(stage => [stage.taskType, stage.label]));
    return fromStages;
  }, []);

  const message = useMemo(() => {
    if (pipelineError) return pipelineError;
    if (pollError) return `Auto refresh issue: ${pollError}`;
    if (hasFailures && failedStage) {
      const label = statusLabelMap[failedStage.taskType] ?? failedStage.taskType;
      return `Digest failed at ${label}. Resolve the issue and retry.`;
    }
    return null;
  }, [failedStage, hasFailures, pipelineError, pollError, statusLabelMap]);

  const handleDigestClick = useCallback(async () => {
    setIsDigestButtonBusy(true);
    setPipelineError(null);
    setSummary(null);
    setTags(null);
    setScreenshot(null);
    setSlug(null);
    try {
      const res = await fetch(`/api/inbox/${inboxId}/digest`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || res.statusText);
      }
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
  }, [inboxId, refreshDigest]);

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
