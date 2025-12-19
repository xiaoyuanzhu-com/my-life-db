import { lazy, Suspense, useState, useCallback, useEffect, useMemo } from 'react';
import { Download, Share2, Sparkles } from 'lucide-react';
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
import { DigestsPanel } from './ui/digests-panel';
import { ModalLayout, useModalLayout, getModalContainerStyles } from './ui/modal-layout';
import { useModalNavigation } from '~/contexts/modal-navigation-context';
import type { AudioSyncState } from './modal-contents/audio-content';

// Lazy load modal content components
const AudioContent = lazy(() => import('./modal-contents/audio-content').then(m => ({ default: m.AudioContent })));
const VideoContent = lazy(() => import('./modal-contents/video-content').then(m => ({ default: m.VideoContent })));
const ImageContent = lazy(() => import('./modal-contents/image-content').then(m => ({ default: m.ImageContent })));
const TextContent = lazy(() => import('./modal-contents/text-content').then(m => ({ default: m.TextContent })));
const PdfContent = lazy(() => import('./modal-contents/pdf-content').then(m => ({ default: m.PdfContent })));
const EpubContent = lazy(() => import('./modal-contents/epub-content').then(m => ({ default: m.EpubContent })));

type ModalView = 'content' | 'digests';

/**
 * Centralized modal component that renders at the provider level.
 * Keeps the Dialog mounted while navigating between files to prevent flash.
 */
export function NavigationModal() {
  const { currentFile, prevFile, nextFile, isOpen, hasPrev, hasNext, closeModal, goToPrev, goToNext } = useModalNavigation();
  const [activeView, setActiveView] = useState<ModalView>('content');
  const [audioSync, setAudioSync] = useState<AudioSyncState | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const layout = useModalLayout();

  // Reset view and state when file changes
  useEffect(() => {
    setActiveView('content');
    setAudioSync(null);
    setIsDirty(false);
  }, [currentFile?.path]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      // TODO: Handle unsaved changes confirmation for text files
      closeModal();
    }
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

  const handleToggleDigests = useCallback(() => {
    setActiveView(prev => prev === 'digests' ? 'content' : 'digests');
  }, []);

  const handleCloseDigests = useCallback(() => {
    setActiveView('content');
  }, []);

  const modalActions: ContextMenuAction[] = useMemo(() => [
    { icon: Download, label: 'Download', onClick: handleDownload, hidden: isIOS() },
    { icon: Share2, label: 'Share', onClick: handleShare, hidden: !canShare() },
    { icon: Sparkles, label: 'Digests', onClick: handleToggleDigests },
  ], [handleDownload, handleShare, handleToggleDigests]);

  const showDigests = activeView === 'digests';
  const containerStyles = getModalContainerStyles(layout, showDigests);

  // Determine content type for the current file
  const contentType = currentFile ? getFileContentType(currentFile) : null;

  // Build digests panel props (with audio sync for audio files)
  const digestsPanelProps = useMemo(() => {
    if (!currentFile) return null;
    return {
      file: currentFile,
      ...(contentType === 'audio' && audioSync ? { audioSync } : {}),
    };
  }, [currentFile, contentType, audioSync]);

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
        <ModalCloseButton onClick={() => handleOpenChange(false)} isDirty={isDirty} />
        <ModalActionButtons actions={modalActions} />

        {currentFile && digestsPanelProps && (
          <ModalLayout
            showDigests={showDigests}
            onCloseDigests={handleCloseDigests}
            digestsContent={<DigestsPanel {...digestsPanelProps} />}
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
                    showDigests={showDigests}
                    onClose={() => handleOpenChange(false)}
                    onAudioSyncChange={setAudioSync}
                    onDirtyStateChange={setIsDirty}
                  />
                </Suspense>
              </motion.div>
            </AnimatePresence>
          </ModalLayout>
        )}

        {/* Preload adjacent images for smoother navigation */}
        <PreloadAdjacentFiles prevFile={prevFile} nextFile={nextFile} />
      </DialogContent>
    </Dialog>
  );
}

// Content renderer for different file types
function ModalContentRenderer({
  contentType,
  file,
  showDigests,
  onClose,
  onAudioSyncChange,
  onDirtyStateChange,
}: {
  contentType: string | null;
  file: NonNullable<ReturnType<typeof useModalNavigation>['currentFile']>;
  showDigests: boolean;
  onClose: () => void;
  onAudioSyncChange: (sync: AudioSyncState | null) => void;
  onDirtyStateChange: (isDirty: boolean) => void;
}) {
  switch (contentType) {
    case 'image':
      return (
        <ImageContent
          file={file}
          showDigests={showDigests}
          onClose={onClose}
        />
      );

    case 'video':
      return <VideoContent file={file} />;

    case 'audio':
      return (
        <AudioContent
          file={file}
          onAudioSyncChange={onAudioSyncChange}
        />
      );

    case 'pdf':
      return <PdfContent file={file} />;

    case 'epub':
      return <EpubContent file={file} />;

    case 'text':
      return (
        <TextContent
          file={file}
          onDirtyStateChange={onDirtyStateChange}
        />
      );

    default:
      // Fallback for unknown types
      return (
        <div className="w-full h-full flex items-center justify-center bg-muted">
          <div className="text-center p-8">
            <div className="text-lg font-medium">{file.name}</div>
            {file.mimeType && (
              <div className="text-sm text-muted-foreground mt-2">{file.mimeType}</div>
            )}
          </div>
        </div>
      );
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
