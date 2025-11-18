'use client';

import { X } from 'lucide-react';

interface OpenedFile {
  path: string;
  name: string;
}

interface FileTabsProps {
  files: OpenedFile[];
  activeFile: string | null;
  onTabChange: (path: string) => void;
  onTabClose: (path: string) => void;
}

export function FileTabs({ files, activeFile, onTabChange, onTabClose }: FileTabsProps) {
  const handleTabClick = (path: string) => {
    onTabChange(path);
  };

  const handleCloseClick = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    onTabClose(path);
  };

  if (files.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-0.5 bg-muted/30 px-1 pt-1 overflow-x-auto">
      {files.map((file) => {
        const isActive = activeFile === file.path;
        return (
          <div
            key={file.path}
            className={`
              group flex items-center gap-2 px-3 py-1.5 cursor-pointer
              rounded-t-lg transition-all duration-150 min-w-[120px] max-w-[200px]
              ${isActive
                ? 'bg-background shadow-sm border-t border-x border-border'
                : 'bg-muted/50 opacity-60 hover:opacity-80 hover:bg-muted'
              }
            `}
            onClick={() => handleTabClick(file.path)}
          >
            <span className="text-sm truncate flex-1" title={file.name}>
              {file.name}
            </span>
            <button
              className="hover:bg-accent rounded p-0.5 transition-colors shrink-0"
              onClick={(e) => handleCloseClick(e, file.path)}
              aria-label="Close tab"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
