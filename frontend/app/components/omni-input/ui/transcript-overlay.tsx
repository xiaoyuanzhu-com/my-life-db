interface TranscriptOverlayProps {
  existingContent: string;
  finalizedText: string;
  partialText: string;
  className?: string;
}

export function TranscriptOverlay({
  existingContent,
  finalizedText,
  partialText,
  className = ''
}: TranscriptOverlayProps) {
  if (!finalizedText && !partialText) {
    return null;
  }

  return (
    <div className={`absolute inset-0 px-4 pt-2 pointer-events-none text-base whitespace-pre-wrap overflow-y-auto ${className}`}>
      {/* Invisible existing content to maintain layout */}
      <span className="invisible">{existingContent}</span>

      {/* Finalized transcript in foreground color */}
      <span className="text-foreground">
        {existingContent ? ' ' : ''}
        {finalizedText}
      </span>

      {/* Partial transcript in muted color */}
      {partialText && (
        <span className="text-muted-foreground/60">
          {finalizedText ? ' ' : ''}
          {partialText}
        </span>
      )}
    </div>
  );
}
