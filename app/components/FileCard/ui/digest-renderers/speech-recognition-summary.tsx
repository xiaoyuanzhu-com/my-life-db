/**
 * Speech Recognition Summary Renderer
 * Displays markdown summary of speech transcripts
 */

import { useMemo } from 'react';
import { marked } from 'marked';
import type { DigestRendererProps } from './index';

interface SpeechRecognitionSummary {
  summary?: string;
}

export function SpeechRecognitionSummaryRenderer({ content }: DigestRendererProps) {
  const html = useMemo(() => {
    if (!content) return null;

    let summary: string;
    try {
      const data: SpeechRecognitionSummary = JSON.parse(content);
      summary = data.summary ?? content;
    } catch {
      // Fallback for plain text summary
      summary = content;
    }

    return marked.parse(summary, { async: false }) as string;
  }, [content]);

  if (!html) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No summary available
      </p>
    );
  }

  return (
    <div
      className="prose prose-sm max-w-none text-foreground prose-headings:text-foreground prose-strong:text-foreground prose-p:text-foreground/90 prose-li:text-foreground/90 prose-headings:font-semibold prose-h1:text-base prose-h2:text-sm prose-h3:text-sm prose-p:leading-relaxed prose-li:leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
