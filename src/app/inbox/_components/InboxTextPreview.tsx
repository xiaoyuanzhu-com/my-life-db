'use client';

import { cn } from '@/lib/utils';

interface Props {
  text?: string | null;
  maxChars?: number;
  className?: string;
}

export function InboxTextPreview({ text, maxChars = 500, className }: Props) {
  const display = (text ?? '').trim();

  if (!display) {
    return (
      <div className={cn('text-sm text-muted-foreground italic', className)}>
        No text content
      </div>
    );
  }

  const shortened = display.length > maxChars ? `${display.slice(0, maxChars).trimEnd()}…` : display;

  return (
    <div className={cn('text-sm whitespace-pre-wrap break-words leading-6 text-foreground', className)}>
      {shortened}
    </div>
  );
}
