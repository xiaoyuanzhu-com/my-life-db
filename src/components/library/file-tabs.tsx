'use client';

import { Fragment } from 'react';
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
    <div className="flex items-center gap-0.5 bg-muted/80 px-1 pt-1 overflow-x-auto border-b-0">
      {files.map((file, index) => {
        const isActive = activeFile === file.path;
        const prevFile = index > 0 ? files[index - 1] : null;
        const isPrevActive = prevFile ? activeFile === prevFile.path : false;
        const showDivider = !isActive && !isPrevActive && index > 0;

        return (
          <Fragment key={file.path}>
            {showDivider && (
              <div className="h-4 w-px bg-border self-center" />
            )}
            <div
              className={`
                group flex items-center gap-2 px-3 py-1.5 cursor-default relative select-none
                transition-all duration-150 min-w-[120px] max-w-[200px]
                ${isActive
                  ? 'bg-background shadow-sm border-t border-x border-border rounded-t-lg before:absolute before:bottom-0 before:-left-2 before:w-2 before:h-2 before:rounded-br-lg before:shadow-[2px_2px_0_0] before:shadow-background after:absolute after:bottom-0 after:-right-2 after:w-2 after:h-2 after:rounded-bl-lg after:shadow-[-2px_2px_0_0] after:shadow-background'
                  : 'bg-muted/80 opacity-70 hover:opacity-90 hover:bg-muted rounded-t-lg'
                }
              `}
            style={isActive ? {
              borderBottomLeftRadius: '0',
              borderBottomRightRadius: '0',
            } : undefined}
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
          </Fragment>
        );
      })}
    </div>
  );
}
