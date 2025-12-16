import { useEffect, useRef, useState, useCallback } from 'react';
import { Download, Share2, Sparkles } from 'lucide-react';
import ePub, { Book, Rendition } from 'epubjs';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { BaseModalProps, ContextMenuAction } from '../types';
import { getFileContentUrl, downloadFile, shareFile, canShare, isIOS } from '../utils';
import { ModalCloseButton } from '../ui/modal-close-button';
import { ModalActionButtons } from '../ui/modal-action-buttons';
import { DigestsPanel } from '../ui/digests-panel';

type ModalView = 'content' | 'digests';

export function EpubModal({ file, open, onOpenChange }: BaseModalProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [activeView, setActiveView] = useState<ModalView>('content');

  // Initialize epub when viewer is ready
  useEffect(() => {
    if (!open || !isReady || !viewerRef.current) return;

    let cancelled = false;

    const initEpub = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const url = getFileContentUrl(file);
        const book = ePub(url);
        bookRef.current = book;

        if (cancelled || !viewerRef.current) return;

        // Get container dimensions for fixed page sizing
        const container = viewerRef.current;
        const width = container.clientWidth;
        const height = container.clientHeight;

        const rendition = book.renderTo(container, {
          width: width,
          height: height,
          spread: 'none',
          flow: 'scrolled',
          manager: 'continuous',
          allowScriptedContent: true,
        });
        renditionRef.current = rendition;

        await rendition.display();
        if (!cancelled) {
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Failed to load EPUB:', err);
        if (!cancelled) {
          setError('Failed to load EPUB');
          setIsLoading(false);
        }
      }
    };

    initEpub();

    return () => {
      cancelled = true;
      if (renditionRef.current) {
        renditionRef.current.destroy();
        renditionRef.current = null;
      }
      if (bookRef.current) {
        bookRef.current.destroy();
        bookRef.current = null;
      }
    };
  }, [open, isReady, file.path]);

  // Reset ready state when dialog closes
  useEffect(() => {
    if (!open) {
      setIsReady(false);
      setIsLoading(true);
      setActiveView('content');
    }
  }, [open]);

  // Ref callback to detect when viewer div is mounted
  const setViewerRef = useCallback((node: HTMLDivElement | null) => {
    viewerRef.current = node;
    if (node) {
      setIsReady(true);
    }
  }, []);

  const handleDownload = useCallback(() => {
    downloadFile(file.path, file.name);
  }, [file.path, file.name]);

  const handleShare = useCallback(() => {
    shareFile(file.path, file.name, file.mimeType);
  }, [file.path, file.name, file.mimeType]);

  const handleToggleDigests = useCallback(() => {
    setActiveView((prev) => (prev === 'digests' ? 'content' : 'digests'));
  }, []);

  const modalActions: ContextMenuAction[] = [
    { icon: Download, label: 'Download', onClick: handleDownload, hidden: isIOS() },
    { icon: Share2, label: 'Share', onClick: handleShare, hidden: !canShare() },
    { icon: Sparkles, label: 'Digests', onClick: handleToggleDigests },
  ];

  const showDigests = activeView === 'digests';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`max-h-[90vh] h-[90vh] p-0 border-none rounded-none shadow-none bg-transparent outline-none overflow-hidden ${
          showDigests ? 'max-w-[90vw] w-full' : 'max-w-[90vw] sm:max-w-[90vw] w-[800px]'
        }`}
        showCloseButton={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <VisuallyHidden>
          <DialogTitle>{file.name}</DialogTitle>
          <DialogDescription>EPUB reader</DialogDescription>
        </VisuallyHidden>
        <ModalCloseButton onClick={() => onOpenChange(false)} />
        <ModalActionButtons actions={modalActions} />

        {/* Desktop: side-by-side, Mobile: horizontal scroll with snap */}
        <div className={`h-full ${
          showDigests
            ? 'flex overflow-x-auto snap-x snap-mandatory md:overflow-x-hidden'
            : 'flex'
        }`}>
          <div className={`relative bg-white rounded-lg overflow-auto flex-shrink-0 ${showDigests ? 'w-full md:w-1/2 snap-center' : 'flex-1'}`}>
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center text-muted-foreground bg-white">
                Loading EPUB...
              </div>
            )}
            {error && (
              <div className="absolute inset-0 flex items-center justify-center text-destructive bg-white">
                {error}
              </div>
            )}
            <div ref={setViewerRef} className="w-full h-full" />
          </div>
          {showDigests && (
            <div className="w-full md:w-1/2 h-full bg-background border-l border-border rounded-r-lg flex-shrink-0 snap-center">
              <DigestsPanel file={file} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
