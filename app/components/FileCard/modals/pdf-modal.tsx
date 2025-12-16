import { useState, useMemo, useCallback, useEffect } from 'react';
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
import { ModalLayout, useModalLayout, getModalContainerStyles } from '../ui/modal-layout';

// Configure pdf.js worker using Vite's ?url import
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

type ModalView = 'content' | 'digests';

export function PdfModal({ file, open, onOpenChange }: BaseModalProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [activeView, setActiveView] = useState<ModalView>('content');
  const layout = useModalLayout();

  // Memoize file source to prevent react-pdf from treating it as a new file on each render
  const src = useMemo(() => ({ url: getFileContentUrl(file) }), [file]);

  // Reset view when modal opens
  useEffect(() => {
    if (open) {
      setActiveView('content');
    }
  }, [open]);

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  // PDF page width based on layout content width (with some padding)
  const pageWidth = Math.min(layout.contentWidth - 32, 800);

  const handleDownload = useCallback(() => {
    downloadFile(file.path, file.name);
  }, [file.path, file.name]);

  const handleShare = useCallback(() => {
    shareFile(file.path, file.name, file.mimeType);
  }, [file.path, file.name, file.mimeType]);

  const handleToggleDigests = useCallback(() => {
    setActiveView((prev) => (prev === 'digests' ? 'content' : 'digests'));
  }, []);

  const handleCloseDigests = useCallback(() => {
    setActiveView('content');
  }, []);

  const modalActions: ContextMenuAction[] = [
    { icon: Download, label: 'Download', onClick: handleDownload, hidden: isIOS() },
    { icon: Share2, label: 'Share', onClick: handleShare, hidden: !canShare() },
    { icon: Sparkles, label: 'Digests', onClick: handleToggleDigests },
  ];

  const showDigests = activeView === 'digests';
  const containerStyles = getModalContainerStyles(layout, showDigests);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="p-0 border-none rounded-none shadow-none bg-transparent outline-none overflow-hidden"
        style={containerStyles}
        showCloseButton={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <VisuallyHidden>
          <DialogTitle>{file.name}</DialogTitle>
        </VisuallyHidden>
        <ModalCloseButton onClick={() => onOpenChange(false)} />
        <ModalActionButtons actions={modalActions} />
        <ModalLayout
          showDigests={showDigests}
          onCloseDigests={handleCloseDigests}
          digestsContent={<DigestsPanel file={file} />}
          contentClassName="overflow-auto"
        >
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
        </ModalLayout>
      </DialogContent>
    </Dialog>
  );
}
