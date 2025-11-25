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
  selectTextOnOpen?: boolean;
}

type Position = 'above' | 'below' | 'middle';

export function MobileContextMenu({
  actions,
  trigger,
  open,
  onOpenChange,
  selectTextOnOpen = false,
}: MobileContextMenuProps) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>('above');
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const [arrowStyle, setArrowStyle] = useState<React.CSSProperties>({});

  // Select all text in trigger when menu opens (for text content)
  useEffect(() => {
    if (open && selectTextOnOpen && triggerRef.current) {
      // Clear any existing selection first
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
      }

      // Delay selection slightly to ensure menu is rendered and previous selection is cleared
      const timer = setTimeout(() => {
        const sel = window.getSelection();
        const range = document.createRange();

        // Find text content within the trigger (only within the card, not outside)
        const textElement = triggerRef.current?.querySelector('.prose');
        if (textElement && sel) {
          try {
            range.selectNodeContents(textElement);
            sel.removeAllRanges();
            sel.addRange(range);
          } catch (e) {
            console.error('Failed to select text:', e);
          }
        }
      }, 100);

      return () => {
        clearTimeout(timer);
        // Clear selection when menu closes
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
        }
      };
    }
  }, [open, selectTextOnOpen]);

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

  // Add touch event listener with { passive: false } to allow preventDefault
  useEffect(() => {
    const element = triggerRef.current;
    if (!element) return;

    let longPressTimeout: ReturnType<typeof setTimeout> | null = null;
    let hasMoved = false;
    let startX = 0;
    let startY = 0;

    const handleTouchStart = (e: TouchEvent) => {
      hasMoved = false;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;

      longPressTimeout = setTimeout(() => {
        // Only trigger if user hasn't moved (not scrolling)
        if (!hasMoved) {
          // Prevent default text selection on long-press for text content
          if (selectTextOnOpen) {
            e.preventDefault();
          }
          onOpenChange(true);
        }
      }, 500);

      const handleTouchMove = (moveEvent: TouchEvent) => {
        // Check if moved more than 10px (threshold for scroll detection)
        const deltaX = Math.abs(moveEvent.touches[0].clientX - startX);
        const deltaY = Math.abs(moveEvent.touches[0].clientY - startY);

        if (deltaX > 10 || deltaY > 10) {
          hasMoved = true;
          if (longPressTimeout) {
            clearTimeout(longPressTimeout);
            longPressTimeout = null;
          }
        }
      };

      const cleanup = () => {
        if (longPressTimeout) {
          clearTimeout(longPressTimeout);
          longPressTimeout = null;
        }
        element.removeEventListener('touchend', cleanup);
        element.removeEventListener('touchmove', handleTouchMove);
      };

      element.addEventListener('touchend', cleanup);
      element.addEventListener('touchmove', handleTouchMove);
    };

    // Add with { passive: false } to allow preventDefault for text selection
    // But only preventDefault in the timeout, not on initial touch (allows scroll)
    element.addEventListener('touchstart', handleTouchStart, { passive: !selectTextOnOpen });

    return () => {
      element.removeEventListener('touchstart', handleTouchStart);
      if (longPressTimeout) {
        clearTimeout(longPressTimeout);
      }
    };
  }, [selectTextOnOpen, onOpenChange]);

  // Add/remove class to prevent system selection UI when menu is open
  useEffect(() => {
    const element = triggerRef.current;
    if (!element) return;

    if (open && selectTextOnOpen) {
      element.classList.add('mobile-menu-open');
    } else {
      element.classList.remove('mobile-menu-open');
    }

    return () => {
      element.classList.remove('mobile-menu-open');
    };
  }, [open, selectTextOnOpen]);

  // Clone trigger with ref and context menu handler
  const triggerWithHandlers = React.cloneElement(trigger, {
    ref: triggerRef,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      onOpenChange(true);
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
            <div
              className="p-1 grid gap-1 w-fit"
              style={{
                gridTemplateColumns: `repeat(${Math.min(actions.length, 5)}, minmax(0, 1fr))`
              }}
            >
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
                      'flex flex-col items-center justify-center gap-1 p-2 rounded-md min-w-0',
                      'active:scale-95 transition-all select-none',
                      'disabled:opacity-50 disabled:pointer-events-none',
                      action.variant === 'destructive'
                        ? 'text-destructive active:bg-destructive/10'
                        : 'text-foreground active:bg-accent'
                    )}
                  >
                    <Icon className="w-5 h-5 shrink-0 pointer-events-none" />
                    <span className="text-[10px] font-medium leading-tight text-center break-words w-full px-0.5 select-none">
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
