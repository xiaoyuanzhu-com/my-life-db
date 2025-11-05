'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import type { InboxEnrichmentSummary, InboxItem } from '@/types';
import { InboxTextPreview } from './InboxTextPreview';

type InboxItemWithEnrichment = InboxItem & { enrichment: InboxEnrichmentSummary };

interface DigestScreenshot {
  src: string;
  mimeType: string;
  filename: string;
}

interface DigestResponse {
  screenshot?: DigestScreenshot | null;
}

interface InboxItemCardProps {
  item: InboxItemWithEnrichment;
}

export function InboxItemCard({ item }: InboxItemCardProps) {
  const [screenshot, setScreenshot] = useState<DigestScreenshot | null>(null);
  const [isLoadingScreenshot, setIsLoadingScreenshot] = useState(false);

  useEffect(() => {
    let ignore = false;
    const controller = new AbortController();

    async function loadScreenshot() {
      if (!item.enrichment?.screenshotReady) {
        setScreenshot(null);
        setIsLoadingScreenshot(false);
        return;
      }

      setIsLoadingScreenshot(true);

      try {
        const res = await fetch(`/api/inbox/${item.id}/digest`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Failed to load digest');
        const json = (await res.json()) as DigestResponse;
        if (!ignore) {
          setScreenshot(json?.screenshot ?? null);
        }
      } catch {
        if (!ignore) {
          setScreenshot(null);
        }
      } finally {
        if (!ignore) {
          setIsLoadingScreenshot(false);
        }
      }
    }

    loadScreenshot();

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [item.id, item.enrichment?.screenshotReady]);

  const backgroundStyle = useMemo(
    () =>
      screenshot
        ? ({
            backgroundImage: `url(${screenshot.src})`,
          } satisfies CSSProperties)
        : undefined,
    [screenshot]
  );

  const createdLabel = useMemo(() => {
    try {
      return formatDistanceToNow(new Date(item.createdAt), { addSuffix: true });
    } catch {
      return '';
    }
  }, [item.createdAt]);

  return (
    <div
      className={cn(
        'relative h-64 overflow-hidden rounded-2xl border border-border bg-muted shadow-sm transition-all duration-300',
        'group-hover:-translate-y-1 group-hover:shadow-lg'
      )}
    >
      <div
        className={cn(
          'absolute inset-0 bg-cover bg-center transition-transform duration-500 ease-out',
          screenshot ? 'opacity-100 group-hover:scale-105' : 'opacity-0'
        )}
        style={backgroundStyle}
        aria-hidden="true"
      />

      <div className="absolute inset-0 bg-gradient-to-br from-background via-background/75 to-background/40" />

      <div className="relative z-10 flex h-full flex-col">
        <div className="p-4">
          <InboxTextPreview
            folderName={item.folderName}
            files={item.files}
            maxChars={220}
            className="text-base font-medium leading-7 text-foreground drop-shadow-[0_4px_18px_rgba(15,23,42,0.4)]"
          />
        </div>

        <div className="mt-auto px-4 pb-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground/90">
            <span className="rounded-full bg-background/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider backdrop-blur-sm">
              {item.type}
            </span>
            {createdLabel && (
              <span className="text-[11px] font-medium">{createdLabel}</span>
            )}
          </div>
          {(!screenshot || isLoadingScreenshot) && (
            <div className="mt-2 text-[11px] text-muted-foreground/70">
              {isLoadingScreenshot ? 'Loading screenshot…' : 'No screenshot available yet'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
