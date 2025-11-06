'use client';

import Image from 'next/image';
import { useMemo } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import type { InboxEnrichmentSummary, InboxItem, InboxDigestScreenshot } from '@/types';
import { InboxTextPreview } from './InboxTextPreview';

interface InboxItemCardProps {
  item: InboxItem & {
    enrichment: InboxEnrichmentSummary;
    primaryText: string | null;
    digestScreenshot: InboxDigestScreenshot | null;
  };
}

export function InboxItemCard({ item }: InboxItemCardProps) {
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
      {item.digestScreenshot && (
        <Image
          src={item.digestScreenshot.src}
          alt="URL screenshot preview"
          fill
          sizes="(max-width: 768px) 100vw, 33vw"
          className="object-cover transition-transform duration-500 ease-out group-hover:scale-105"
          priority={false}
        />
      )}

      <div className="absolute inset-0 bg-gradient-to-br from-background via-background/75 to-background/40" />

      <div className="relative z-10 flex h-full flex-col">
        <div className="p-4">
          <InboxTextPreview
            text={item.primaryText}
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
          {!item.digestScreenshot && (
            <div className="mt-2 text-[11px] text-muted-foreground/70">
              No screenshot available yet
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
