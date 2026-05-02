import { useState, useEffect, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { cn } from '~/lib/utils';
import type { ModalNavigationProps } from '../types';
import { useModalKeyboardNavigation, useModalSwipeNavigation } from './use-modal-navigation';

// Constants
const A4_RATIO = 1.414; // √2
const ASPECT_THRESHOLD = 1 / A4_RATIO; // ~0.707

export type LayoutMode = 'landscape' | 'portrait';

export interface ModalLayoutConfig {
  mode: LayoutMode;
  contentWidth: number; // in pixels
  contentHeight: number; // in pixels
}

/**
 * Hook to calculate modal layout based on viewport dimensions.
 *
 * Design principle: Maximize A4-ratio modal within viewport.
 * - Landscape (vw/vh >= 0.707): 64vh x 90vh
 * - Portrait (vw/vh < 0.707): 100vw x min(141vw, 95vh)
 */
export function useModalLayout(): ModalLayoutConfig {
  const [config, setConfig] = useState<ModalLayoutConfig>(() => calculateLayout());

  useEffect(() => {
    const handleResize = () => {
      setConfig(calculateLayout());
    };

    window.addEventListener('resize', handleResize);
    // Also listen for orientation changes on mobile
    window.addEventListener('orientationchange', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

  return config;
}

function calculateLayout(): ModalLayoutConfig {
  // SSR safety: return default values if window is not available
  if (typeof window === 'undefined') {
    return {
      mode: 'landscape',
      contentWidth: 640,
      contentHeight: 900,
    };
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const aspectRatio = vw / vh;

  let mode: LayoutMode;
  let contentWidth: number;
  let contentHeight: number;

  if (aspectRatio >= ASPECT_THRESHOLD) {
    // Landscape mode: height-constrained
    mode = 'landscape';
    contentWidth = Math.min(vh * 0.64, vw); // 64vh, capped at 100vw
    contentHeight = vh * 0.9; // 90vh
  } else {
    // Portrait mode: width-constrained
    mode = 'portrait';
    contentWidth = vw; // 100vw
    contentHeight = Math.min(vw * A4_RATIO, vh * 0.95); // 141vw, capped at 95vh
  }

  return {
    mode,
    contentWidth,
    contentHeight,
  };
}

// Props for the ModalLayout component
export interface ModalLayoutProps extends ModalNavigationProps {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  /** Whether navigation is enabled (swipe and keyboard). Defaults to true. */
  navigationEnabled?: boolean;
}

/**
 * ModalLayout component that handles:
 * - Responsive sizing based on viewport (A4 ratio)
 * - Keyboard and swipe navigation between files
 */
export function ModalLayout({
  children,
  className,
  contentClassName,
  navigationEnabled,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: ModalLayoutProps) {
  const layout = useModalLayout();

  const isSwipeNavigationEnabled = navigationEnabled ?? true;
  const isKeyboardNavigationEnabled = navigationEnabled ?? true;

  // Enable keyboard navigation (left/right arrows)
  useModalKeyboardNavigation({
    isOpen: true, // ModalLayout is only rendered when modal is open
    enabled: isKeyboardNavigationEnabled,
    hasPrev,
    hasNext,
    onPrev,
    onNext,
  });

  // Get swipe navigation handlers
  const { handleDragEnd: handleNavigationDragEnd } = useModalSwipeNavigation({
    enabled: isSwipeNavigationEnabled,
    hasPrev,
    hasNext,
    onPrev,
    onNext,
  });

  // Check if swipe navigation is available
  const hasSwipeNavigation = (hasPrev || hasNext) && isSwipeNavigationEnabled;

  return (
    <div
      className={cn('relative overflow-hidden', className)}
      style={{
        width: layout.contentWidth,
        height: layout.contentHeight,
        maxWidth: '100vw',
        maxHeight: '100vh',
      }}
    >
      {/* Main content pane - wrapped in motion.div for swipe navigation */}
      {hasSwipeNavigation ? (
        <motion.div
          className={cn('h-full', contentClassName)}
          style={{ width: layout.contentWidth }}
          drag="x"
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={{ left: hasNext ? 0.3 : 0, right: hasPrev ? 0.3 : 0 }}
          onDragEnd={handleNavigationDragEnd}
        >
          {children}
        </motion.div>
      ) : (
        <div
          className={cn('h-full', contentClassName)}
          style={{ width: layout.contentWidth }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Get CSS styles for DialogContent based on layout
 */
export function getModalContainerStyles(layout: ModalLayoutConfig): React.CSSProperties {
  return {
    width: layout.contentWidth,
    height: layout.contentHeight,
    maxWidth: '100vw',
    maxHeight: '100vh',
  };
}

/**
 * Get content pane dimensions
 */
export function getContentPaneStyles(layout: ModalLayoutConfig): React.CSSProperties {
  return {
    width: layout.contentWidth,
    height: layout.contentHeight,
  };
}
