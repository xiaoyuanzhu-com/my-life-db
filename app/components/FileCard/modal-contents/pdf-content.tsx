import { useState, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import type { FileWithDigests } from '~/types/file-card';
import { getFileContentUrl } from '../utils';
import { useModalLayout } from '../ui/modal-layout';

// Configure pdf.js worker using Vite's ?url import
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface PdfContentProps {
  file: FileWithDigests;
}

export function PdfContent({ file }: PdfContentProps) {
  const [numPages, setNumPages] = useState<number | null>(null);
  const layout = useModalLayout();

  // Memoize file source to prevent react-pdf from treating it as a new file on each render
  const src = useMemo(() => ({ url: getFileContentUrl(file) }), [file]);

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  // PDF page width based on layout content width (with some padding)
  const pageWidth = Math.min(layout.contentWidth - 32, 800);

  return (
    <div className="w-full h-full overflow-auto">
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
  );
}
