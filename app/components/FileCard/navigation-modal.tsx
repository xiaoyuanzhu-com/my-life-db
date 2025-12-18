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

// Lazy load heavy modal content
const PdfModalContent = lazy(() => import('./modal-contents/pdf-content').then(m => ({ default: m.PdfContent })));
const EpubModalContent = lazy(() => import('./modal-contents/epub-content').then(m => ({ default: m.EpubContent })));

type ModalView = 'content' | 'digests';

/**
 * Centralized modal component that renders at the provider level.
 * Keeps the Dialog mounted while navigating between files to prevent flash.
 */
export function NavigationModal() {
  const { currentFile, isOpen, hasPrev, hasNext, closeModal, goToPrev, goToNext } = useModalNavigation();
  const [activeView, setActiveView] = useState<ModalView>('content');
  const layout = useModalLayout();

  // Reset view when file changes
  useEffect(() => {
    setActiveView('content');
  }, [currentFile?.path]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
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
        <ModalCloseButton onClick={() => handleOpenChange(false)} />
        <ModalActionButtons actions={modalActions} />

        {currentFile && (
          <ModalLayout
            showDigests={showDigests}
            onCloseDigests={handleCloseDigests}
            digestsContent={<DigestsPanel file={currentFile} />}
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
                <ModalContentRenderer
                  contentType={contentType}
                  file={currentFile}
                  showDigests={showDigests}
                  onClose={() => handleOpenChange(false)}
                />
              </motion.div>
            </AnimatePresence>
          </ModalLayout>
        )}
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
}: {
  contentType: string | null;
  file: NonNullable<ReturnType<typeof useModalNavigation>['currentFile']>;
  showDigests: boolean;
  onClose: () => void;
}) {
  const src = getFileContentUrl(file);

  switch (contentType) {
    case 'image':
      return (
        <div
          className="w-full h-full flex items-center justify-center cursor-pointer"
          onClick={() => !showDigests && onClose()}
        >
          <img
            src={src}
            alt={file.name}
            className="object-contain"
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              width: 'auto',
              height: 'auto',
            }}
          />
        </div>
      );

    case 'video':
      return (
        <div className="w-full h-full flex items-center justify-center bg-black">
          <video
            key={file.path}
            controls
            autoPlay
            playsInline
            className="w-full h-full object-contain"
          >
            <source src={src} type={file.mimeType || 'video/mp4'} />
            Your browser does not support the video tag.
          </video>
        </div>
      );

    case 'audio':
      return (
        <div className="w-full h-full flex items-center justify-center bg-muted">
          <div className="text-center p-8">
            <div className="text-lg font-medium mb-4">{file.name}</div>
            <audio controls autoPlay className="w-full max-w-md">
              <source src={src} type={file.mimeType || 'audio/mpeg'} />
              Your browser does not support the audio tag.
            </audio>
          </div>
        </div>
      );

    case 'pdf':
      return (
        <Suspense fallback={<LoadingFallback />}>
          <PdfModalContent file={file} />
        </Suspense>
      );

    case 'epub':
      return (
        <Suspense fallback={<LoadingFallback />}>
          <EpubModalContent file={file} />
        </Suspense>
      );

    case 'text':
      return (
        <div className="w-full h-full overflow-auto bg-background p-4">
          <pre className="whitespace-pre-wrap break-words text-sm font-mono">
            {file.textPreview || 'No preview available'}
          </pre>
        </div>
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
