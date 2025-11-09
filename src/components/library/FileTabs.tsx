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
    <div className="flex items-center border-b bg-muted/30 overflow-x-auto">
      {files.map((file) => (
        <div
          key={file.path}
          className={`
            group flex items-center gap-2 px-3 py-2 border-r cursor-pointer
            hover:bg-accent transition-colors
            ${activeFile === file.path ? 'bg-background' : ''}
          `}
          onClick={() => handleTabClick(file.path)}
        >
          <span className="text-sm truncate max-w-[150px]" title={file.name}>
            {file.name}
          </span>
          <button
            className="opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted rounded p-0.5"
            onClick={(e) => handleCloseClick(e, file.path)}
            aria-label="Close tab"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
