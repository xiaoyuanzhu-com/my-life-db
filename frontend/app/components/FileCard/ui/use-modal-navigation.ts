import { useEffect, useCallback } from 'react';
import type { PanInfo } from 'framer-motion';
import type { ModalNavigationProps } from '../types';
import type { FileWithDigests } from '~/types/file-card';
import { useModalNavigationSafe } from '~/contexts/modal-navigation-context';

/**
 * Hook to get modal opener for cards.
 * Cards should always be used within a ModalNavigationProvider.
 * The provider's NavigationModal handles rendering the modal content.
 *
 * @example
 * ```tsx
 * const openModal = useCardModal(file);
 * return <div onClick={openModal}>...</div>;
 * ```
 */
export function useCardModal(file: FileWithDigests) {
  const navigation = useModalNavigationSafe();

  return useCallback(() => {
    if (navigation) {
      navigation.openModal(file);
    }
  }, [navigation]); // eslint-disable-line react-hooks/exhaustive-deps
  // Note: file is intentionally not in deps to avoid infinite re-renders
  // The callback always uses the latest file from closure
}

interface UseModalNavigationOptions extends ModalNavigationProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Whether navigation should be enabled (e.g., disable when digests panel is open) */
  enabled?: boolean;
}

/**
 * Hook to handle modal navigation via keyboard and swipe gestures.
 *
 * Keyboard:
 * - Left arrow: go to previous file
 * - Right arrow: go to next file
 *
 * Swipe (for use with framer-motion):
 * - Swipe left: go to next file
 * - Swipe right: go to previous file
 */
export function useModalKeyboardNavigation({
  isOpen,
  enabled = true,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: UseModalNavigationOptions) {
  useEffect(() => {
    if (!isOpen || !enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if user is typing in an input
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'ArrowLeft' && hasPrev && onPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === 'ArrowRight' && hasNext && onNext) {
        e.preventDefault();
        onNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, enabled, hasPrev, hasNext, onPrev, onNext]);
}

interface SwipeNavigationHandlers {
  handleDragEnd: (event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => void;
}

/**
 * Create swipe handlers for modal navigation.
 * Swipe left to go next, swipe right to go previous.
 */
export function useModalSwipeNavigation({
  enabled = true,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: Omit<UseModalNavigationOptions, 'isOpen'>): SwipeNavigationHandlers {
  const handleDragEnd = useCallback(
    (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (!enabled) return;

      const threshold = 100;
      const velocityThreshold = 500;

      // Swipe right (positive x offset) -> go to previous
      if ((info.offset.x > threshold || info.velocity.x > velocityThreshold) && hasPrev && onPrev) {
        onPrev();
      }
      // Swipe left (negative x offset) -> go to next
      else if ((info.offset.x < -threshold || info.velocity.x < -velocityThreshold) && hasNext && onNext) {
        onNext();
      }
    },
    [enabled, hasPrev, hasNext, onPrev, onNext]
  );

  return { handleDragEnd };
}
