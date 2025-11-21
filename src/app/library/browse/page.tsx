'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { FileTree } from '@/components/library/file-tree';
import { FileViewer } from '@/components/library/file-viewer';
import { FileTabs } from '@/components/library/file-tabs';
import { Button } from '@/components/ui/button';

export interface OpenedFile {
  path: string;
  name: string;
}

interface FileEditState {
  content: string;
  isDirty: boolean;
}

export default function LibraryBrowsePage() {
  const [openedFiles, setOpenedFiles] = useState<OpenedFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [fileEditStates, setFileEditStates] = useState<Map<string, FileEditState>>(new Map());
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());

  // Load state from localStorage on mount
  useEffect(() => {
    try {
      const savedOpenedFiles = localStorage.getItem('library:openedFiles');
      const savedActiveFile = localStorage.getItem('library:activeFile');
      const savedExpandedFolders = localStorage.getItem('library:expandedFolders');
      const savedFileEditStates = localStorage.getItem('library:fileEditStates');
      const savedDirtyFiles = localStorage.getItem('library:dirtyFiles');

      if (savedOpenedFiles) {
        setOpenedFiles(JSON.parse(savedOpenedFiles));
      }
      if (savedActiveFile) {
        setActiveFilePath(savedActiveFile);
      }
      if (savedExpandedFolders) {
        setExpandedFolders(new Set(JSON.parse(savedExpandedFolders)));
      }
      if (savedFileEditStates) {
        const statesArray: [string, FileEditState][] = JSON.parse(savedFileEditStates);
        setFileEditStates(new Map(statesArray));
      }
      if (savedDirtyFiles) {
        setDirtyFiles(new Set(JSON.parse(savedDirtyFiles)));
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

  // Save file edit states to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('library:fileEditStates', JSON.stringify(Array.from(fileEditStates.entries())));
    } catch (error) {
      console.error('Failed to save file edit states to localStorage:', error);
    }
  }, [fileEditStates]);

  // Save dirty files to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('library:dirtyFiles', JSON.stringify(Array.from(dirtyFiles)));
    } catch (error) {
      console.error('Failed to save dirty files to localStorage:', error);
    }
  }, [dirtyFiles]);

  const handleFileOpen = (path: string, name: string) => {
    // Add to opened files if not already open
    if (!openedFiles.some(f => f.path === path)) {
      setOpenedFiles([...openedFiles, { path, name }]);
    }
    setActiveFilePath(path);
  };

  const handleFileClose = useCallback((path: string) => {
    if (dirtyFiles.has(path)) {
      const confirmed = window.confirm(
        'This file has unsaved changes. Are you sure you want to close it?'
      );
      if (!confirmed) {
        return;
      }
    }

    setOpenedFiles(prev => {
      const next = prev.filter(f => f.path !== path);
      setActiveFilePath(prevActive => (prevActive === path ? (next[next.length - 1]?.path ?? null) : prevActive));
      return next;
    });

    setFileEditStates(prev => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });

    setDirtyFiles(prev => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, [dirtyFiles]);

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

  const handleContentChange = useCallback((filePath: string, content: string, isDirty: boolean) => {
    setFileEditStates(prev => {
      const newMap = new Map(prev);
      newMap.set(filePath, { content, isDirty });
      return newMap;
    });

    setDirtyFiles(prev => {
      const newSet = new Set(prev);
      if (isDirty) {
        newSet.add(filePath);
      } else {
        newSet.delete(filePath);
      }
      return newSet;
    });
  }, []);

  // Keyboard shortcut for Cmd/Ctrl+W to close active tab
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'w' && activeFilePath) {
        e.preventDefault();
        handleFileClose(activeFilePath);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeFilePath, handleFileClose]);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-foreground">Library Browser</h1>
        </div>
        <Link href="/library">
          <Button variant="ghost" size="sm">
            ← Back to Library
          </Button>
        </Link>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
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
                dirtyFiles={dirtyFiles}
                onTabChange={handleTabChange}
                onTabClose={handleFileClose}
              />

              {/* Content viewer */}
              <div className="flex-1 overflow-hidden">
                {activeFilePath && (
                  <FileViewer
                    filePath={activeFilePath}
                    onContentChange={handleContentChange}
                    initialEditedContent={fileEditStates.get(activeFilePath)?.content}
                  />
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
  );
}
