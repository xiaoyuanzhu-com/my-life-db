'use client';

import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

export interface MobileContextMenuAction {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
}

export interface MobileContextMenuProps {
  actions: MobileContextMenuAction[];
  trigger: React.ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Position = 'above' | 'below' | 'middle';

export function MobileContextMenu({
  actions,
  trigger,
  open,
  onOpenChange,
}: MobileContextMenuProps) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>('above');
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const [arrowStyle, setArrowStyle] = useState<React.CSSProperties>({});

  // Calculate position when menu opens
  useEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;

    const calculatePosition = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      // Get the main scrollable container (viewport)
      const viewport = document.querySelector('.flex-1.overflow-hidden.relative') as HTMLElement;
      const viewportRect = viewport?.getBoundingClientRect() || {
        top: 0,
        left: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        width: window.innerWidth,
        height: window.innerHeight,
      };

      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();

      const gap = 12; // Space between trigger and menu
      const arrowSize = 8; // Triangle arrow height

      // Calculate available space
      const spaceAbove = triggerRect.top - viewportRect.top;
      const spaceBelow = viewportRect.bottom - triggerRect.bottom;
      const menuHeight = menuRect.height;

      let newPosition: Position = 'above';
      let top = 0;
      let left = 0;

      // Determine position: above → below → middle
      if (spaceAbove >= menuHeight + gap + arrowSize) {
        // Position above
        newPosition = 'above';
        top = triggerRect.top - menuHeight - gap - arrowSize;
      } else if (spaceBelow >= menuHeight + gap + arrowSize) {
        // Position below
        newPosition = 'below';
        top = triggerRect.bottom + gap + arrowSize;
      } else {
        // Position in middle of viewport
        newPosition = 'middle';
        top = viewportRect.top + (viewportRect.height - menuHeight) / 2;
      }

      // Center horizontally relative to trigger
      const triggerCenter = triggerRect.left + triggerRect.width / 2;
      left = triggerCenter - menuRect.width / 2;

      // Keep menu within viewport bounds horizontally
      const padding = 16;
      if (left < viewportRect.left + padding) {
        left = viewportRect.left + padding;
      } else if (left + menuRect.width > viewportRect.right - padding) {
        left = viewportRect.right - padding - menuRect.width;
      }

      setPosition(newPosition);
      setMenuStyle({ top, left });

      // Calculate arrow position
      if (newPosition !== 'middle') {
        const arrowLeft = triggerCenter - left;
        setArrowStyle({ left: arrowLeft });
      }
    };

    // Initial calculation
    calculatePosition();

    // Recalculate on resize or scroll
    window.addEventListener('resize', calculatePosition);
    window.addEventListener('scroll', calculatePosition, true);

    return () => {
      window.removeEventListener('resize', calculatePosition);
      window.removeEventListener('scroll', calculatePosition, true);
    };
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        triggerRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        onOpenChange(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [open, onOpenChange]);

  // Handle trigger long-press
  const handleTriggerLongPress = (event: React.TouchEvent | React.MouseEvent) => {
    event.preventDefault();
    onOpenChange(true);
  };

  // Clone trigger and add long-press handlers
  const triggerWithHandlers = React.cloneElement(trigger, {
    ref: triggerRef,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      onOpenChange(true);
    },
    onTouchStart: (e: React.TouchEvent) => {
      const timeout = setTimeout(() => {
        handleTriggerLongPress(e);
      }, 500);

      const cleanup = () => {
        clearTimeout(timeout);
        document.removeEventListener('touchend', cleanup);
        document.removeEventListener('touchmove', cleanup);
      };

      document.addEventListener('touchend', cleanup);
      document.addEventListener('touchmove', cleanup);
    },
  });

  return (
    <>
      {triggerWithHandlers}

      {open && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/20"
            onClick={() => onOpenChange(false)}
          />

          {/* Menu */}
          <div
            ref={menuRef}
            className={cn(
              'fixed z-50 bg-popover border border-border rounded-lg shadow-lg',
              'animate-in fade-in-0 zoom-in-95',
              position === 'above' && 'slide-in-from-bottom-2',
              position === 'below' && 'slide-in-from-top-2',
              position === 'middle' && 'slide-in-from-bottom-4'
            )}
            style={menuStyle}
          >
            {/* Arrow */}
            {position !== 'middle' && (
              <div
                className={cn(
                  'absolute left-0 w-0 h-0 border-l-8 border-r-8 border-l-transparent border-r-transparent',
                  position === 'above' &&
                    'bottom-[-8px] border-t-8 border-t-popover',
                  position === 'below' &&
                    'top-[-8px] border-b-8 border-b-popover'
                )}
                style={arrowStyle}
              />
            )}

            {/* Grid of actions */}
            <div className="p-3 grid grid-cols-5 gap-2 max-w-[min(90vw,400px)]">
              {actions.map((action, index) => {
                const Icon = action.icon;
                return (
                  <button
                    key={index}
                    onClick={() => {
                      if (!action.disabled) {
                        action.onClick();
                        onOpenChange(false);
                      }
                    }}
                    disabled={action.disabled}
                    className={cn(
                      'flex flex-col items-center justify-center gap-1 p-2 rounded-md',
                      'active:scale-95 transition-all',
                      'disabled:opacity-50 disabled:pointer-events-none',
                      action.variant === 'destructive'
                        ? 'text-destructive active:bg-destructive/10'
                        : 'text-foreground active:bg-accent'
                    )}
                  >
                    <Icon className="w-5 h-5 shrink-0" />
                    <span className="text-[10px] font-medium leading-tight text-center break-words max-w-full">
                      {action.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </>
  );
}
