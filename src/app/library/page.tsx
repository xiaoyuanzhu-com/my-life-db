'use client';

import { useState, useEffect } from 'react';
import { FileTree } from '@/components/library/FileTree';
import { FileViewer } from '@/components/library/FileViewer';
import { FileTabs } from '@/components/library/FileTabs';

export interface OpenedFile {
  path: string;
  name: string;
}

export default function LibraryPage() {
  const [openedFiles, setOpenedFiles] = useState<OpenedFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Load state from localStorage on mount
  useEffect(() => {
    try {
      const savedOpenedFiles = localStorage.getItem('library:openedFiles');
      const savedActiveFile = localStorage.getItem('library:activeFile');
      const savedExpandedFolders = localStorage.getItem('library:expandedFolders');

      if (savedOpenedFiles) {
        setOpenedFiles(JSON.parse(savedOpenedFiles));
      }
      if (savedActiveFile) {
        setActiveFilePath(savedActiveFile);
      }
      if (savedExpandedFolders) {
        setExpandedFolders(new Set(JSON.parse(savedExpandedFolders)));
      }
    } catch (error) {
      console.error('Failed to load state from localStorage:', error);
    }
  }, []);

  // Save opened files to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('library:openedFiles', JSON.stringify(openedFiles));
    } catch (error) {
      console.error('Failed to save opened files to localStorage:', error);
    }
  }, [openedFiles]);

  // Save active file to localStorage
  useEffect(() => {
    try {
      if (activeFilePath) {
        localStorage.setItem('library:activeFile', activeFilePath);
      }
    } catch (error) {
      console.error('Failed to save active file to localStorage:', error);
    }
  }, [activeFilePath]);

  // Save expanded folders to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('library:expandedFolders', JSON.stringify(Array.from(expandedFolders)));
    } catch (error) {
      console.error('Failed to save expanded folders to localStorage:', error);
    }
  }, [expandedFolders]);

  const handleFileOpen = (path: string, name: string) => {
    // Add to opened files if not already open
    if (!openedFiles.some(f => f.path === path)) {
      setOpenedFiles([...openedFiles, { path, name }]);
    }
    setActiveFilePath(path);
  };

  const handleFileClose = (path: string) => {
    const newOpenedFiles = openedFiles.filter(f => f.path !== path);
    setOpenedFiles(newOpenedFiles);

    // If closing the active file, switch to the last opened file
    if (activeFilePath === path) {
      if (newOpenedFiles.length > 0) {
        setActiveFilePath(newOpenedFiles[newOpenedFiles.length - 1].path);
      } else {
        setActiveFilePath(null);
      }
    }
  };

  const handleTabChange = (path: string) => {
    setActiveFilePath(path);
  };

  const handleToggleFolder = (path: string, isExpanded: boolean) => {
    const newExpandedFolders = new Set(expandedFolders);
    if (isExpanded) {
      newExpandedFolders.add(path);
    } else {
      newExpandedFolders.delete(path);
    }
    setExpandedFolders(newExpandedFolders);
  };

  return (
    <div className="flex flex-col flex-1 bg-background">
      {/* Main content */}
      <div className="flex-1 overflow-hidden">
        <div className="px-[10%] h-full">
          <div className="flex h-full">
            {/* Left sidebar - File tree */}
            <div className="w-64 border-r overflow-y-auto">
              <FileTree
                onFileOpen={handleFileOpen}
                expandedFolders={expandedFolders}
                onToggleFolder={handleToggleFolder}
              />
            </div>

            {/* Right content - File viewer with tabs */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {openedFiles.length > 0 ? (
                <>
                  {/* Tabs */}
                  <FileTabs
                    files={openedFiles}
                    activeFile={activeFilePath}
                    onTabChange={handleTabChange}
                    onTabClose={handleFileClose}
                  />

                  {/* Content viewer */}
                  <div className="flex-1 overflow-hidden">
                    {activeFilePath && (
                      <FileViewer filePath={activeFilePath} />
                    )}
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  Select a file from the tree to view
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
