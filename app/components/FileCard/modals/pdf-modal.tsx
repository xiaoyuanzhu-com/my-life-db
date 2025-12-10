import { useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '~/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import type { BaseModalProps } from '../types';
import { getRawFileUrl } from '../utils';
import { ModalCloseButton } from '../ui/modal-close-button';

// Configure pdf.js worker using Vite's ?url import
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export function PdfModal({ file, open, onOpenChange }: BaseModalProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageWidth, setPageWidth] = useState<number | null>(null);

  const src = getRawFileUrl(file.path);

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  // Calculate page width based on viewport
  const updatePageWidth = () => {
    const maxWidth = Math.min(window.innerWidth * 0.9 - 32, 800);
    setPageWidth(maxWidth);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[90vw] sm:max-w-[90vw] max-h-[90vh] w-fit p-4 overflow-hidden flex flex-col"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          updatePageWidth();
        }}
      >
        <VisuallyHidden>
          <DialogTitle>{file.name}</DialogTitle>
        </VisuallyHidden>
        <ModalCloseButton onClick={() => onOpenChange(false)} />

        <div className="flex-1 overflow-auto">
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
      </DialogContent>
    </Dialog>
  );
}
