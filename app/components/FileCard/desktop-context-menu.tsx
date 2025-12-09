'use client';

import * as React from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '~/components/ui/context-menu';

export interface DesktopContextMenuProps {
  children: React.ReactNode;
  trigger: React.ReactElement;
}

export function DesktopContextMenu({ children, trigger }: DesktopContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">{children}</ContextMenuContent>
    </ContextMenu>
  );
}
