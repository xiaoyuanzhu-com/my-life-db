import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { motion, AnimatePresence, type PanInfo } from 'framer-motion';
import { cn } from '~/lib/utils';

// Constants
const A4_RATIO = 1.414; // √2
const ASPECT_THRESHOLD = 1 / A4_RATIO; // ~0.707
const GAP_REM = 1; // 1rem gap between panes
const SAFETY_MARGIN = 0.95; // 95% of viewport for fitting check

export type LayoutMode = 'landscape' | 'portrait';

export interface ModalLayoutConfig {
  mode: LayoutMode;
  contentWidth: number; // in pixels
  contentHeight: number; // in pixels
  canFitSideBySide: boolean;
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
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const aspectRatio = vw / vh;
  const gap = GAP_REM * 16; // Convert rem to px

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

  // Check if side-by-side layout fits
  const sideBySideWidth = contentWidth * 2 + gap;
  const canFitSideBySide = sideBySideWidth <= vw * SAFETY_MARGIN;

  return {
    mode,
    contentWidth,
    contentHeight,
    canFitSideBySide,
  };
}

// Props for the ModalLayout component
export interface ModalLayoutProps {
  children: ReactNode;
  digestsContent?: ReactNode;
  showDigests: boolean;
  onCloseDigests: () => void;
  className?: string;
  contentClassName?: string;
}

/**
 * ModalLayout component that handles:
 * - Responsive sizing based on viewport (A4 ratio)
 * - Side-by-side vs overlay digests layout
 * - Framer-motion swipe animations for overlay mode
 */
export function ModalLayout({
  children,
  digestsContent,
  showDigests,
  onCloseDigests,
  className,
  contentClassName,
}: ModalLayoutProps) {
  const layout = useModalLayout();
  const gap = GAP_REM * 16;

  // Swipe handler for overlay mode
  const handleDragEnd = useCallback(
    (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      // Swipe right to close (positive x offset)
      if (info.offset.x > 100 || info.velocity.x > 500) {
        onCloseDigests();
      }
    },
    [onCloseDigests]
  );

  // Container dimensions
  const containerWidth = showDigests && layout.canFitSideBySide
    ? layout.contentWidth * 2 + gap
    : layout.contentWidth;

  return (
    <div
      className={cn('relative overflow-hidden', className)}
      style={{
        width: containerWidth,
        height: layout.contentHeight,
        maxWidth: '100vw',
        maxHeight: '100vh',
      }}
    >
      {/* Main content pane */}
      <div
        className={cn('h-full', contentClassName)}
        style={{
          width: layout.contentWidth,
        }}
      >
        {children}
      </div>

      {/* Digests panel */}
      <AnimatePresence>
        {showDigests && digestsContent && (
          layout.canFitSideBySide ? (
            // Side-by-side layout
            <motion.div
              key="digests-side"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.2 }}
              className="absolute top-0 h-full overflow-hidden"
              style={{
                left: layout.contentWidth + gap,
                width: layout.contentWidth,
              }}
            >
              {digestsContent}
            </motion.div>
          ) : (
            // Overlay layout with swipe-to-dismiss
            <motion.div
              key="digests-overlay"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={{ left: 0, right: 0.5 }}
              onDragEnd={handleDragEnd}
              className="absolute inset-0 overflow-hidden touch-pan-y"
              style={{
                width: layout.contentWidth,
              }}
            >
              {digestsContent}
            </motion.div>
          )
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Get CSS styles for DialogContent based on layout
 */
export function getModalContainerStyles(layout: ModalLayoutConfig, showDigests: boolean): React.CSSProperties {
  const gap = GAP_REM * 16;
  const width = showDigests && layout.canFitSideBySide
    ? layout.contentWidth * 2 + gap
    : layout.contentWidth;

  return {
    width,
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
