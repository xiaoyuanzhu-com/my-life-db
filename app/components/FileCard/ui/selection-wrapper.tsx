import { Circle, CheckCircle2 } from 'lucide-react';
import { cn } from '~/lib/utils';
import { useSelectionSafe } from '~/contexts/selection-context';

interface SelectionWrapperProps {
  path: string;
  children: React.ReactNode;
  className?: string;
  /** Called when clicking in non-selection mode */
  onNormalClick?: () => void;
}

/**
 * Wrapper component that adds selection behavior to card content.
 * In selection mode:
 * - Shows a circle checkbox on the left
 * - Clicking toggles selection instead of normal behavior
 * Outside selection mode:
 * - Renders children normally with optional click handler
 */
export function SelectionWrapper({
  path,
  children,
  className,
  onNormalClick,
}: SelectionWrapperProps) {
  const selection = useSelectionSafe();

  // If not within SelectionProvider, just render children
  if (!selection) {
    return <>{children}</>;
  }

  const { isSelectionMode, isSelected, toggleSelection } = selection;
  const selected = isSelected(path);

  const handleClick = (e: React.MouseEvent) => {
    if (isSelectionMode) {
      e.preventDefault();
      e.stopPropagation();
      toggleSelection(path);
    } else if (onNormalClick) {
      onNormalClick();
    }
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSelection(path);
  };

  if (!isSelectionMode) {
    return <>{children}</>;
  }

  return (
    <div
      className={cn(
        'flex items-start gap-2 w-full',
        className
      )}
      onClick={handleClick}
    >
      {/* Selection checkbox */}
      <button
        type="button"
        onClick={handleCheckboxClick}
        className={cn(
          'flex-shrink-0 mt-1 p-1 rounded-full transition-colors',
          'hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
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

      {/* Card content - full width minus checkbox */}
      <div className="flex-1 min-w-0">
        {children}
      </div>
    </div>
  );
}
