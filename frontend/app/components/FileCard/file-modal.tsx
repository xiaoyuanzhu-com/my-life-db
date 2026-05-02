import { lazy, Suspense, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Download, Share2 } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { ContextMenuAction } from './types';
import { getFileContentType, downloadFile, shareFile, canShare, isIOS, getFileContentUrl } from './utils';
import { ModalCloseButton } from './ui/modal-close-button';
import { ModalActionButtons } from './ui/modal-action-buttons';
import { ModalLayout, useModalLayout, getModalContainerStyles } from './ui/modal-layout';
import { useModalNavigation } from '~/contexts/modal-navigation-context';
import type { TextContentHandle } from './modal-contents/text-content';

// Direct imports for small content viewers (bundle in main)
import { AudioContent } from './modal-contents/audio-content';
import { VideoContent } from './modal-contents/video-content';
import { ImageContent } from './modal-contents/image-content';
import { TextContent } from './modal-contents/text-content';
import { MarkdownContent } from './modal-contents/markdown-content';
import { HtmlContent } from './modal-contents/html-content';
import { FallbackContent } from './modal-contents/fallback-content';

// Lazy load large libraries only
const PdfContent = lazy(() => import('./modal-contents/pdf-content').then(m => ({ default: m.PdfContent })));
const EpubContent = lazy(() => import('./modal-contents/epub-content').then(m => ({ default: m.EpubContent })));

/**
 * FileModal - Centralized modal component that renders at the provider level.
 *
 * Design principles:
 * 1. Navigation is transparent to content - content components don't know about navigation
 * 2. Each modal is an A4 rounded content with background
 *
 * Keeps the Dialog mounted while navigating between files to prevent flash.
 */
export function FileModal() {
  const { currentFile, prevFile, nextFile, isOpen, hasPrev, hasNext, closeModal, goToPrev, goToNext } = useModalNavigation();
  const [isDirty, setIsDirty] = useState(false);
  const layout = useModalLayout();

  // Ref for TextContent imperative handle
  const textContentRef = useRef<TextContentHandle>(null);

  // Reset state when file changes
  useEffect(() => {
    setIsDirty(false);
  }, [currentFile?.path]);

  // Handle close request - delegates to TextContent if it has unsaved changes
  const handleCloseRequest = useCallback(() => {
    const contentType = currentFile ? getFileContentType(currentFile) : null;

    // For text files, check with TextContent first
    if (contentType === 'text' && textContentRef.current) {
      const canClose = textContentRef.current.requestClose();
      if (!canClose) {
        // TextContent will show its own dialog
        return;
      }
    }

    closeModal();
  }, [currentFile, closeModal]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      handleCloseRequest();
    }
  }, [handleCloseRequest]);

  // Called by TextContent after user confirms close (save or discard)
  const handleTextCloseConfirmed = useCallback(() => {
    closeModal();
  }, [closeModal]);

  const handleDownload = useCallback(() => {
    if (currentFile) {
      downloadFile(currentFile.path, currentFile.name);
    }
  }, [currentFile]);

  const handleShare = useCallback(() => {
    if (currentFile) {
      shareFile(currentFile.path, currentFile.name, currentFile.mimeType);
    }
  }, [currentFile]);

  const modalActions: ContextMenuAction[] = useMemo(() => [
    { icon: Download, label: 'Download', onClick: handleDownload, hidden: isIOS() },
    { icon: Share2, label: 'Share', onClick: handleShare, hidden: !canShare() },
  ], [handleDownload, handleShare]);

  const containerStyles = getModalContainerStyles(layout);

  // Determine content type for the current file
  const contentType = currentFile ? getFileContentType(currentFile) : null;

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="p-0 border-none rounded-none shadow-none !bg-transparent outline-none overflow-hidden"
        style={containerStyles}
        showCloseButton={false}
      >
        <VisuallyHidden>
          <DialogTitle>{currentFile?.name ?? 'File Preview'}</DialogTitle>
        </VisuallyHidden>
        <ModalCloseButton onClick={handleCloseRequest} isDirty={isDirty} />
        <ModalActionButtons actions={modalActions} />

        {currentFile && (
          <ModalLayout
            contentClassName="flex items-center justify-center"
            hasPrev={hasPrev}
            hasNext={hasNext}
            onPrev={goToPrev}
            onNext={goToNext}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={currentFile.path}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="w-full h-full flex items-center justify-center"
              >
                <Suspense fallback={<LoadingFallback />}>
                  <ModalContentRenderer
                    contentType={contentType}
                    file={currentFile}
                    onClose={handleCloseRequest}
                    onDirtyStateChange={setIsDirty}
                    onTextCloseConfirmed={handleTextCloseConfirmed}
                    textContentRef={textContentRef}
                  />
                </Suspense>
              </motion.div>
            </AnimatePresence>
          </ModalLayout>
        )}

        {/* Preload adjacent files for smoother navigation */}
        <PreloadAdjacentFiles prevFile={prevFile} nextFile={nextFile} />
      </DialogContent>
    </Dialog>
  );
}

// Content renderer for different file types
function ModalContentRenderer({
  contentType,
  file,
  onClose,
  onDirtyStateChange,
  onTextCloseConfirmed,
  textContentRef,
}: {
  contentType: string | null;
  file: NonNullable<ReturnType<typeof useModalNavigation>['currentFile']>;
  onClose: () => void;
  onDirtyStateChange: (isDirty: boolean) => void;
  onTextCloseConfirmed: () => void;
  textContentRef: React.RefObject<TextContentHandle | null>;
}) {
  switch (contentType) {
    case 'image':
      return (
        <ImageContent
          file={file}
          onClose={onClose}
        />
      );

    case 'video':
      return <VideoContent file={file} />;

    case 'audio':
      return <AudioContent file={file} />;

    case 'pdf':
      return <PdfContent file={file} />;

    case 'epub':
      return <EpubContent file={file} />;

    case 'text':
      return (
        <TextContent
          ref={textContentRef}
          file={file}
          onDirtyStateChange={onDirtyStateChange}
          onCloseConfirmed={onTextCloseConfirmed}
        />
      );

    case 'markdown':
      return (
        <MarkdownContent
          ref={textContentRef}
          file={file}
          onDirtyStateChange={onDirtyStateChange}
          onCloseConfirmed={onTextCloseConfirmed}
        />
      );

    case 'html':
      return (
        <HtmlContent
          ref={textContentRef}
          file={file}
          onDirtyStateChange={onDirtyStateChange}
          onCloseConfirmed={onTextCloseConfirmed}
        />
      );

    default:
      return <FallbackContent file={file} />;
  }
}

function LoadingFallback() {
  return (
    <div className="w-full h-full flex items-center justify-center bg-background/80">
      <div className="text-muted-foreground">Loading...</div>
    </div>
  );
}

/**
 * Preload adjacent files for smoother navigation.
 * Uses requestIdleCallback to defer preloading until the browser is idle,
 * so it doesn't compete with current content loading.
 */
function PreloadAdjacentFiles({
  prevFile,
  nextFile,
}: {
  prevFile: ReturnType<typeof useModalNavigation>['prevFile'];
  nextFile: ReturnType<typeof useModalNavigation>['nextFile'];
}) {
  useEffect(() => {
    const files = [prevFile, nextFile].filter(Boolean);
    if (files.length === 0) return;

    // Use requestIdleCallback to preload when browser is idle
    const idleCallback = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 200));
    const cancelCallback = window.cancelIdleCallback ?? clearTimeout;

    const id = idleCallback(() => {
      files.forEach((file) => {
        if (!file) return;
        const src = getFileContentUrl(file);
        // Low priority fetch to cache the resource
        fetch(src, { priority: 'low' } as RequestInit).catch(() => {});
      });
    });

    return () => cancelCallback(id);
  }, [prevFile, nextFile]);

  return null;
}
