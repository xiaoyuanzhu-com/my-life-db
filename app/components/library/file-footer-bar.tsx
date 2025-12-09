import { Info, FileText } from 'lucide-react';
import { Link } from 'react-router';

interface FileFooterBarProps {
  filePath: string | null;
  mimeType: string | null;
}

export function FileFooterBar({ filePath, mimeType }: FileFooterBarProps) {
  if (!filePath) {
    return null;
  }

  // Encode the file path for URL
  const infoUrl = `/file/${filePath}`;

  return (
    <div className="flex items-center justify-end gap-2 h-6 px-2 text-xs text-muted-foreground shrink-0">
      {mimeType && (
        <span className="flex items-center gap-1.5 font-mono select-none px-2 py-0.5 rounded hover:bg-accent hover:text-foreground transition-colors">
          <FileText className="w-3.5 h-3.5" />
          {mimeType}
        </span>
      )}
      <Link
        to={infoUrl}
        className="flex items-center gap-1.5 hover:text-foreground transition-colors px-2 py-0.5 rounded hover:bg-accent"
        title="View file information and digests"
      >
        <Info className="w-3.5 h-3.5" />
        <span>Details</span>
      </Link>
    </div>
  );
}
