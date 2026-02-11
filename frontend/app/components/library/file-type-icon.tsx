import { cn } from '~/lib/utils';

/** Get a short display label for the extension (max ~4 chars) */
function getExtLabel(ext: string): string {
  // Shorten long extensions
  if (ext === 'jpeg') return 'JPG';
  if (ext === 'docx') return 'DOC';
  if (ext === 'xlsx') return 'XLS';
  if (ext === 'pptx') return 'PPT';
  if (ext === 'epub') return 'PUB';
  return ext.toUpperCase();
}

interface FileTypeIconProps {
  filename: string;
  className?: string;
  /** Icon size in px. Default 40. */
  size?: number;
}

/**
 * A file-shaped icon with a colored extension badge.
 *
 * Visual: A rounded-corner file shape (with a folded corner)
 * and a small colored pill showing the extension.
 */
export function FileTypeIcon({ filename, className, size = 40 }: FileTypeIconProps) {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const label = getExtLabel(ext);

  // Scale proportionally
  const w = size;
  const h = size * 1.2;
  const badgeFontSize = Math.max(7, size * 0.22);
  const foldSize = size * 0.25;

  return (
    <div
      className={cn('relative shrink-0', className)}
      style={{ width: w, height: h }}
    >
      {/* File body — SVG for the shape with folded corner */}
      <svg
        viewBox="0 0 40 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        {/* Main file shape */}
        <path
          d="M4 4C4 1.79086 5.79086 0 8 0H26L36 10V44C36 46.2091 34.2091 48 32 48H8C5.79086 48 4 46.2091 4 44V4Z"
          className="fill-muted-foreground/15 dark:fill-muted-foreground/20"
        />
        {/* Folded corner */}
        <path
          d="M26 0L36 10H30C27.7909 10 26 8.20914 26 6V0Z"
          className="fill-muted-foreground/25 dark:fill-muted-foreground/35"
        />
      </svg>

      {/* Extension badge */}
      {ext && (
        <div
          className={cn(
            'absolute left-1/2 -translate-x-1/2 rounded px-1 font-bold leading-none',
            'bg-muted-foreground/80 text-background',
          )}
          style={{
            bottom: h * 0.18,
            fontSize: badgeFontSize,
            paddingTop: badgeFontSize * 0.3,
            paddingBottom: badgeFontSize * 0.3,
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
