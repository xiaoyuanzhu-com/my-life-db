import { useEffect, useCallback, useState, useMemo } from 'react';
import type { PanInfo } from 'framer-motion';
import type { ModalNavigationProps } from '../types';
import type { FileWithDigests } from '~/types/file-card';
import { useModalNavigationSafe } from '~/contexts/modal-navigation-context';

/**
 * Hook to manage modal state for cards, integrating with navigation context when available.
 *
 * When inside a ModalNavigationProvider:
 * - Modal open/close is controlled by the context
 * - Navigation props are provided for prev/next navigation
 *
 * When outside a provider (standalone card usage):
 * - Falls back to local state
 * - No navigation props
 *
 * @example
 * ```tsx
 * const { modalOpen, openModal, closeModal, navigationProps } = useCardModalState(file);
 *
 * return (
 *   <>
 *     <div onClick={openModal}>...</div>
 *     <MyModal open={modalOpen} onOpenChange={closeModal} {...navigationProps} />
 *   </>
 * );
 * ```
 */
export function useCardModalState(file: FileWithDigests) {
  const navigation = useModalNavigationSafe();
  const [localModalOpen, setLocalModalOpen] = useState(false);

  // Compute modal open state
  const modalOpen = navigation
    ? navigation.isOpen && navigation.currentFile?.path === file.path
    : localModalOpen;

  // Open modal handler
  const openModal = useCallback(() => {
    if (navigation) {
      navigation.openModal(file);
    } else {
      setLocalModalOpen(true);
    }
  }, [navigation, file]);

  // Close modal handler (for onOpenChange)
  const closeModal = useCallback((open: boolean) => {
    if (navigation && !open) {
      navigation.closeModal();
    } else {
      setLocalModalOpen(open);
    }
  }, [navigation]);

  // Navigation props to spread onto modal
  const navigationProps: ModalNavigationProps = useMemo(() => ({
    hasPrev: navigation?.hasPrev,
    hasNext: navigation?.hasNext,
    onPrev: navigation?.goToPrev,
    onNext: navigation?.goToNext,
  }), [navigation?.hasPrev, navigation?.hasNext, navigation?.goToPrev, navigation?.goToNext]);

  return {
    modalOpen,
    openModal,
    closeModal,
    navigationProps,
  };
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
