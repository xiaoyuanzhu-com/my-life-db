/**
 * Speech Recognition Summary Renderer
 * Displays markdown summary of speech transcripts
 */

import type { DigestRendererProps } from './index';

interface SpeechRecognitionSummary {
  summary?: string;
}

export function SpeechRecognitionSummaryRenderer({ content }: DigestRendererProps) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">
        No summary available
      </p>
    );
  }

  let summary: string;
  try {
    const data: SpeechRecognitionSummary = JSON.parse(content);
    summary = data.summary ?? content;
  } catch {
    // Fallback for plain text summary
    summary = content;
  }

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <div className="whitespace-pre-wrap text-sm text-foreground leading-relaxed">
        {summary}
      </div>
    </div>
  );
}
