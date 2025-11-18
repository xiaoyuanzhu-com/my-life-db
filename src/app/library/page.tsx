'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileTree } from '@/components/library/file-tree';
import { FileViewer } from '@/components/library/file-viewer';
import { FileTabs } from '@/components/library/file-tabs';
import { FileFooterBar } from '@/components/library/file-footer-bar';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';

export interface OpenedFile {
  path: string;
  name: string;
}

function LibraryContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [openedFiles, setOpenedFiles] = useState<OpenedFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [isInitialized, setIsInitialized] = useState(false);
  const [activeFileMimeType, setActiveFileMimeType] = useState<string | null>(null);

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
    } finally {
      // Mark as initialized after loading from localStorage
      setIsInitialized(true);
    }
  }, []);

  // Save opened files to localStorage (skip on initial mount)
  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem('library:openedFiles', JSON.stringify(openedFiles));
    } catch (error) {
      console.error('Failed to save opened files to localStorage:', error);
    }
  }, [openedFiles, isInitialized]);

  // Save active file to localStorage (skip on initial mount)
  useEffect(() => {
    if (!isInitialized) return;
    try {
      if (activeFilePath) {
        localStorage.setItem('library:activeFile', activeFilePath);
      } else {
        localStorage.removeItem('library:activeFile');
      }
    } catch (error) {
      console.error('Failed to save active file to localStorage:', error);
    }
  }, [activeFilePath, isInitialized]);

  // Save expanded folders to localStorage (skip on initial mount)
  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem('library:expandedFolders', JSON.stringify(Array.from(expandedFolders)));
    } catch (error) {
      console.error('Failed to save expanded folders to localStorage:', error);
    }
  }, [expandedFolders, isInitialized]);

  // Handle ?open query parameter(s) - open files from URL
  useEffect(() => {
    const openParams = searchParams.getAll('open');
    if (openParams.length === 0) return;

    // Process each file path to open
    openParams.forEach(filePath => {
      if (!filePath) return;

      // Extract file name from path
      const fileName = filePath.split('/').pop() || filePath;

      // Use setOpenedFiles with updater function to get the latest state
      setOpenedFiles(prev => {
        // Check if file is already open using the latest state
        const isAlreadyOpen = prev.some(f => f.path === filePath);

        if (isAlreadyOpen) {
          // File already open, just switch to it
          return prev;
        }

        // Add to opened files
        return [...prev, { path: filePath, name: fileName }];
      });

      // Set as active file (the last one in the list will be active)
      setActiveFilePath(filePath);

      // Auto-expand parent folders to reveal the file
      expandParentFolders(filePath);
    });

    // Clean up URL by removing ?open parameters
    router.replace('/library', { scroll: false });
  }, [searchParams, router]); // Intentionally excluding openedFiles to avoid infinite loop

  // Helper function to expand all parent folders of a file path
  const expandParentFolders = (filePath: string) => {
    const pathParts = filePath.split('/');

    setExpandedFolders(prev => {
      const newExpandedFolders = new Set(prev);

      // Build up parent folder paths and add them to expanded set
      // The tree API returns paths with './' prefix at root level (e.g., './inbox')
      // So we need to normalize paths to match
      // e.g., "notes/2024/journal.md" -> expand "./notes" and "./notes/2024"
      // e.g., "inbox/file.md" -> expand "./inbox"
      let currentPath = '';
      for (let i = 0; i < pathParts.length - 1; i++) {
        if (i === 0) {
          // First segment gets ./ prefix
          currentPath = './' + pathParts[i];
        } else {
          currentPath += '/' + pathParts[i];
        }
        newExpandedFolders.add(currentPath);
      }

      return newExpandedFolders;
    });
  };

  const handleFileOpen = (path: string, name: string) => {
    // Add to opened files if not already open
    if (!openedFiles.some(f => f.path === path)) {
      setOpenedFiles([...openedFiles, { path, name }]);
    }
    setActiveFilePath(path);

    // Auto-expand parent folders to keep the file visible
    expandParentFolders(path);
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
    <div className="flex flex-col flex-1 bg-background h-full min-h-0 overflow-hidden">
      {/* Main content */}
      <div className="flex-1 overflow-hidden min-h-0">
        <div className="px-[10%] h-full min-h-0 flex flex-col">
          <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0">
            <ResizablePanel defaultSize={25} minSize={15} className="border-r flex h-full flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto">
                <FileTree
                  onFileOpen={handleFileOpen}
                  expandedFolders={expandedFolders}
                  onToggleFolder={handleToggleFolder}
                  selectedFilePath={activeFilePath}
                />
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={75} minSize={30} className="flex h-full flex-col overflow-hidden">
              {openedFiles.length > 0 && (
                <div className="shrink-0">
                  <FileTabs
                    files={openedFiles}
                    activeFile={activeFilePath}
                    onTabChange={handleTabChange}
                    onTabClose={handleFileClose}
                  />
                </div>
              )}
              <div className="flex-1 min-h-0 overflow-hidden">
                {openedFiles.length > 0 && activeFilePath ? (
                  <FileViewer
                    filePath={activeFilePath}
                    onFileDataLoad={(contentType) => setActiveFileMimeType(contentType)}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    Select a file from the tree to view
                  </div>
                )}
              </div>
              <FileFooterBar filePath={activeFilePath} mimeType={activeFileMimeType} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
    </div>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen">Loading...</div>}>
      <LibraryContent />
    </Suspense>
  );
}
