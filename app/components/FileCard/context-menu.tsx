import { useState } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '~/components/ui/context-menu';
import { MobileContextMenu } from './mobile-context-menu';
import { isTouchDevice } from './utils';
import type { ContextMenuAction } from './types';

export interface ContextMenuWrapperProps {
  actions: ContextMenuAction[];
  children: React.ReactNode;
  selectTextOnOpen?: boolean;
}

/**
 * Unified context menu wrapper that handles both desktop and mobile
 * Desktop: shadcn ContextMenu (right-click)
 * Mobile: Custom long-press menu
 */
export function ContextMenuWrapper({
  actions,
  children,
  selectTextOnOpen = false,
}: ContextMenuWrapperProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Filter out hidden actions
  const visibleActions = actions.filter(action => !action.hidden);

  // Find the index where destructive actions start (for separator)
  const destructiveIndex = visibleActions.findIndex(a => a.variant === 'destructive');

  if (isTouchDevice()) {
    // Mobile: use custom long-press menu
    return (
      <MobileContextMenu
        actions={visibleActions}
        trigger={children as React.ReactElement}
        open={isMobileMenuOpen}
        onOpenChange={setIsMobileMenuOpen}
        selectTextOnOpen={selectTextOnOpen}
      />
    );
  }

  // Desktop: use shadcn ContextMenu
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {visibleActions.map((action, index) => {
          const Icon = action.icon;
          const showSeparator = destructiveIndex > 0 && index === destructiveIndex;

          return (
            <div key={index}>
              {showSeparator && <ContextMenuSeparator />}
              <ContextMenuItem
                onClick={action.onClick}
                disabled={action.disabled}
                variant={action.variant}
              >
                <Icon className="mr-2 h-4 w-4" />
                {action.label}
              </ContextMenuItem>
            </div>
          );
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
}
