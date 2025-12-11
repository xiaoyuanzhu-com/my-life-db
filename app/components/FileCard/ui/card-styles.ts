/**
 * Unified card styling constants
 *
 * All file cards share a consistent visual appearance:
 * - Rounded corners (rounded-lg)
 * - Border (border-border)
 * - Muted background (bg-muted)
 * - No text selection for media cards (touch-callout-none select-none)
 */

/**
 * Base card container classes
 * Use this for the outermost card wrapper
 */
export const cardContainerClass =
  'group relative overflow-hidden rounded-lg border border-border bg-muted touch-callout-none select-none';

/**
 * Card with max width constraint
 * Standard max width for most cards to allow timestamp alignment
 */
export const cardWithMaxWidthClass =
  'group relative overflow-hidden rounded-lg border border-border bg-muted touch-callout-none select-none max-w-[calc(100%-40px)] w-fit';

/**
 * Card with cursor pointer (for clickable cards)
 */
export const cardClickableClass =
  'group relative overflow-hidden rounded-lg border border-border bg-muted touch-callout-none select-none cursor-pointer max-w-[calc(100%-40px)] w-fit';
