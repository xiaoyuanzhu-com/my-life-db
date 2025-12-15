import { cn } from '~/lib/utils';
import { formatTimestamp } from '~/lib/utils/format-timestamp';
import type { FileCardProps } from './types';
import { getFileContentType } from './utils';
import { getCardComponent } from './cards';

export type { FileCardProps } from './types';

/**
 * FileCard - Thin dispatcher component
 *
 * Detects file content type and renders the appropriate card component.
 * All state and logic is owned by the individual card components.
 */
export function FileCard({
  file,
  className,
  showTimestamp = false,
  highlightTerms,
  matchContext,
  priority = false,
  onDeleted,
  onRestoreItem,
  onLocateInFeed,
}: FileCardProps) {
  const contentType = getFileContentType(file);
  const CardComponent = getCardComponent(contentType);

  return (
    <div className={cn('w-full flex flex-col items-end', className)}>
      {showTimestamp && (
        <div className="text-xs text-muted-foreground mb-2 mr-5 select-none">
          {formatTimestamp(file.createdAt)}
        </div>
      )}
      <CardComponent
        file={file}
        highlightTerms={highlightTerms}
        matchContext={matchContext}
        priority={priority}
        onDeleted={onDeleted}
        onRestoreItem={onRestoreItem}
        onLocateInFeed={onLocateInFeed}
      />
    </div>
  );
}
