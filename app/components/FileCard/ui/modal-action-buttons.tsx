import { cn } from '~/lib/utils';
import type { ContextMenuAction } from '../types';

interface ModalActionButtonsProps {
  actions: ContextMenuAction[];
  className?: string;
}

/**
 * Floating action buttons for modals
 * Positioned at bottom-right, horizontal layout
 * Matches close button style (40x40, rounded-full, bg-black/50)
 */
export function ModalActionButtons({ actions, className }: ModalActionButtonsProps) {
  const visibleActions = actions.filter((a) => !a.hidden);

  if (visibleActions.length === 0) return null;

  return (
    <div className={cn('fixed bottom-4 right-4 z-50 flex items-center gap-2', className)}>
      {visibleActions.map((action, i) => {
        const Icon = action.icon;
        return (
          <button
            key={i}
            onClick={action.onClick}
            disabled={action.disabled}
            className={cn(
              'w-10 h-10 rounded-full border-none outline-none',
              'bg-black/50 hover:bg-black/70 disabled:opacity-50',
              'flex items-center justify-center',
              'text-white',
              'transition-colors',
              'touch-manipulation'
            )}
            aria-label={action.label}
          >
            <Icon className="w-5 h-5" />
          </button>
        );
      })}
    </div>
  );
}
