import { ChevronRight, Home } from 'lucide-react';
import { cn } from '~/lib/utils';

interface BreadcrumbNavProps {
  currentPath: string;
  onNavigate: (path: string) => void;
  className?: string;
}

export function BreadcrumbNav({ currentPath, onNavigate, className }: BreadcrumbNavProps) {
  const segments = currentPath ? currentPath.split('/').filter(Boolean) : [];

  return (
    <nav
      className={cn(
        'flex items-center gap-1 overflow-x-auto text-sm scrollbar-none',
        className
      )}
    >
      {/* Root / Home button */}
      <button
        onClick={() => onNavigate('')}
        className={cn(
          'flex items-center gap-1 shrink-0 px-1.5 py-1 rounded-md transition-colors',
          segments.length === 0
            ? 'text-foreground font-medium'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
      >
        <Home className="w-3.5 h-3.5" />
        <span>Library</span>
      </button>

      {/* Path segments */}
      {segments.map((segment, index) => {
        const segmentPath = segments.slice(0, index + 1).join('/');
        const isLast = index === segments.length - 1;

        return (
          <div key={segmentPath} className="flex items-center gap-1 shrink-0">
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <button
              onClick={() => onNavigate(segmentPath)}
              className={cn(
                'px-1.5 py-1 rounded-md transition-colors truncate max-w-[160px]',
                isLast
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
              title={segment}
            >
              {segment}
            </button>
          </div>
        );
      })}
    </nav>
  );
}
