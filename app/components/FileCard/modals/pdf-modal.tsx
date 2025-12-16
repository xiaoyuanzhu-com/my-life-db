import { useState, useMemo, useCallback } from 'react';
import { Download, Share2, Sparkles } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { BaseModalProps, ContextMenuAction } from '../types';
import { getFileContentUrl, downloadFile, shareFile, canShare, isIOS } from '../utils';
import { ModalCloseButton } from '../ui/modal-close-button';
import { ModalActionButtons } from '../ui/modal-action-buttons';
import { DigestsPanel } from '../ui/digests-panel';

// Configure pdf.js worker using Vite's ?url import
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

type ModalView = 'content' | 'digests';

export function PdfModal({ file, open, onOpenChange }: BaseModalProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageWidth, setPageWidth] = useState<number | null>(null);
  const [activeView, setActiveView] = useState<ModalView>('content');

  // Memoize file source to prevent react-pdf from treating it as a new file on each render
  const src = useMemo(() => ({ url: getFileContentUrl(file) }), [file]);

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  // Calculate page width based on viewport and digests panel
  const updatePageWidth = useCallback((showDigests: boolean) => {
    const viewportWidth = showDigests ? window.innerWidth * 0.45 : window.innerWidth * 0.9;
    const maxWidth = Math.min(viewportWidth - 32, 800);
    setPageWidth(maxWidth);
  }, []);

  const handleDownload = useCallback(() => {
    downloadFile(file.path, file.name);
  }, [file.path, file.name]);

  const handleShare = useCallback(() => {
    shareFile(file.path, file.name, file.mimeType);
  }, [file.path, file.name, file.mimeType]);

  const handleToggleDigests = useCallback(() => {
    setActiveView((prev) => {
      const newView = prev === 'digests' ? 'content' : 'digests';
      updatePageWidth(newView === 'digests');
      return newView;
    });
  }, [updatePageWidth]);

  const modalActions: ContextMenuAction[] = [
    { icon: Download, label: 'Download', onClick: handleDownload, hidden: isIOS() },
    { icon: Share2, label: 'Share', onClick: handleShare, hidden: !canShare() },
    { icon: Sparkles, label: 'Digests', onClick: handleToggleDigests },
  ];

  const showDigests = activeView === 'digests';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`max-h-[90vh] p-0 border-none rounded-none shadow-none bg-transparent outline-none overflow-hidden ${
          showDigests ? 'max-w-[90vw] w-full' : 'max-w-[90vw] sm:max-w-[90vw] w-fit'
        }`}
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          updatePageWidth(showDigests);
        }}
      >
        <VisuallyHidden>
          <DialogTitle>{file.name}</DialogTitle>
        </VisuallyHidden>
        <ModalCloseButton onClick={() => onOpenChange(false)} />
        <ModalActionButtons actions={modalActions} />

        {/* Desktop: side-by-side, Mobile: horizontal scroll with snap */}
        <div className={`h-full ${
          showDigests
            ? 'flex overflow-x-auto snap-x snap-mandatory md:overflow-x-hidden'
            : 'flex'
        }`}>
          <div className={`overflow-auto flex-shrink-0 ${showDigests ? 'w-full md:w-1/2 snap-center' : 'flex-1'}`}>
            <Document
              file={src}
              onLoadSuccess={onDocumentLoadSuccess}
              loading={
                <div className="flex items-center justify-center h-64 text-muted-foreground">
                  Loading PDF...
                </div>
              }
              error={
                <div className="flex items-center justify-center h-64 text-destructive">
                  Failed to load PDF
                </div>
              }
            >
              {pageWidth &&
                numPages &&
                Array.from({ length: numPages }, (_, index) => (
                  <Page
                    key={`page_${index + 1}`}
                    pageNumber={index + 1}
                    width={pageWidth}
                    className="mb-4 last:mb-0"
                    loading={
                      <div className="flex items-center justify-center h-64 text-muted-foreground">
                        Loading page {index + 1}...
                      </div>
                    }
                  />
                ))}
            </Document>
          </div>
          {showDigests && (
            <div className="w-full md:w-1/2 h-[90vh] bg-background border-l border-border rounded-r-lg flex-shrink-0 snap-center">
              <DigestsPanel file={file} />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
