import { useEffect, useRef, useState, useCallback } from 'react';
import ePub, { Book, Rendition } from 'epubjs';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { BaseModalProps } from '../types';
import { getRawFileUrl } from '../utils';
import { ModalCloseButton } from '../ui/modal-close-button';

export function EpubModal({ file, open, onOpenChange }: BaseModalProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Initialize epub when viewer is ready
  useEffect(() => {
    if (!open || !isReady || !viewerRef.current) return;

    let cancelled = false;

    const initEpub = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const url = getRawFileUrl(file.path);
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
    }
  }, [open]);

  // Ref callback to detect when viewer div is mounted
  const setViewerRef = useCallback((node: HTMLDivElement | null) => {
    viewerRef.current = node;
    if (node) {
      setIsReady(true);
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[90vw] sm:max-w-[90vw] max-h-[90vh] w-[800px] h-[90vh] p-0 border-none rounded-none shadow-none bg-transparent outline-none overflow-hidden flex flex-col"
        showCloseButton={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <VisuallyHidden>
          <DialogTitle>{file.name}</DialogTitle>
          <DialogDescription>EPUB reader</DialogDescription>
        </VisuallyHidden>
        <ModalCloseButton onClick={() => onOpenChange(false)} />

        <div className="flex-1 relative bg-white rounded-lg overflow-auto">
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
      </DialogContent>
    </Dialog>
  );
}
