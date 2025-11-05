'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  folderName: string;
  files: Array<{ filename: string; type: string }>;
  maxChars?: number;
  className?: string;
}

export function InboxTextPreview({ folderName, files, maxChars = 500, className }: Props) {
  const [text, setText] = useState<string>('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let canceled = false;

    async function load() {
      setLoaded(false);
      // Prefer text.md, fallback to first text-like file, else url.txt
      const candidates: string[] = [];
      const hasTextMd = files.some((f) => f.filename === 'text.md');
      if (hasTextMd) candidates.push('text.md');

      // other text files
      for (const f of files) {
        const lower = f.filename.toLowerCase();
        if (lower.endsWith('.txt') || lower.endsWith('.md')) {
          if (lower !== 'text.md') candidates.push(f.filename);
        }
      }

      // URL fallback
      if (!candidates.includes('url.txt')) candidates.push('url.txt');

      let content = '';
      for (const name of candidates) {
        try {
          const res = await fetch(`/api/inbox/files/${encodeURIComponent(folderName)}/${encodeURIComponent(name)}`);
          if (res.ok) {
            content = await res.text();
            if (content && content.trim().length > 0) break;
          }
        } catch {}
      }

      if (!canceled) {
        setText(content);
        setLoaded(true);
      }
    }

    load();
    return () => {
      canceled = true;
    };
  }, [folderName, files]);

  if (!loaded) {
    return <div className={cn('text-sm text-muted-foreground', className)}>Loading…</div>;
  }

  const display = (text || '').trim();
  if (!display) {
    return (
      <div className={cn('text-sm text-muted-foreground italic', className)}>
        No text content
      </div>
    );
  }

  const shortened = display.length > maxChars ? display.slice(0, maxChars) + '…' : display;

  return (
    <div className={cn('text-sm whitespace-pre-wrap break-words leading-6 text-foreground', className)}>
      {shortened}
    </div>
  );
}
