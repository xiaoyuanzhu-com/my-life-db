import { Circle, CheckCircle2 } from 'lucide-react';
import { cn } from '~/lib/utils';
import { useSelectionSafe } from '~/contexts/selection-context';

interface SelectionWrapperProps {
  path: string;
  children: React.ReactNode;
}

/**
 * Wrapper component that adds selection behavior to card content.
 * In selection mode:
 * - Shows a circle checkbox in the left gutter (absolute positioned)
 * - Clicking the card toggles selection
 * Outside selection mode:
 * - Renders children as-is without any wrapper
 */
export function SelectionWrapper({
  path,
  children,
}: SelectionWrapperProps) {
  const selection = useSelectionSafe();

  // If not within SelectionProvider or not in selection mode, render children as-is
  if (!selection || !selection.isSelectionMode) {
    return <>{children}</>;
  }

  const { isSelected, toggleSelection } = selection;
  const selected = isSelected(path);

  const handleCardClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSelection(path);
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSelection(path);
  };

  // Only wrap when in selection mode
  return (
    <div className="relative w-full">
      {/* Selection checkbox - positioned at left edge of full-width container */}
      <button
        type="button"
        onClick={handleCheckboxClick}
        className={cn(
          'absolute left-0 top-1/2 -translate-y-1/2 p-1 rounded-full z-10',
          'hover:bg-muted/50 focus:outline-none',
          selected ? 'text-primary' : 'text-muted-foreground'
        )}
        aria-label={selected ? 'Deselect item' : 'Select item'}
      >
        {selected ? (
          <CheckCircle2 className="h-5 w-5" />
        ) : (
          <Circle className="h-5 w-5" />
        )}
      </button>

      {/* Card content - click to toggle selection */}
      <div onClick={handleCardClick} className="cursor-pointer">
        {children}
      </div>
    </div>
  );
}
