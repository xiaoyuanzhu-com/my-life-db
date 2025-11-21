'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileTree } from '@/components/library/file-tree';
import { FileViewer } from '@/components/library/file-viewer';
import { FileTabs } from '@/components/library/file-tabs';
import { FileFooterBar } from '@/components/library/file-footer-bar';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export interface OpenedFile {
  path: string;
  name: string;
}

interface FileEditState {
  content: string;
  isDirty: boolean;
}

function LibraryContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [openedFiles, setOpenedFiles] = useState<OpenedFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [fileEditStates, setFileEditStates] = useState<Map<string, FileEditState>>(new Map());
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null);
  const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [activeFileMimeType, setActiveFileMimeType] = useState<string | null>(null);
  const persistFileEditStates = useCallback((next: Map<string, FileEditState>) => {
    try {
      localStorage.setItem('library:fileEditStates', JSON.stringify(Array.from(next.entries())));
    } catch (error) {
      console.error('Failed to save file edit states to localStorage:', error);
    }
  }, []);
  const persistDirtyFiles = useCallback((next: Set<string>) => {
    try {
      localStorage.setItem('library:dirtyFiles', JSON.stringify(Array.from(next)));
    } catch (error) {
      console.error('Failed to save dirty files to localStorage:', error);
    }
  }, []);
  const handleFileDataLoad = useCallback((contentType: string) => {
    setActiveFileMimeType(contentType);
  }, []);

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

  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem('library:fileEditStates', JSON.stringify(Array.from(fileEditStates.entries())));
    } catch (error) {
      console.error('Failed to save file edit states to localStorage:', error);
    }
  }, [fileEditStates, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem('library:dirtyFiles', JSON.stringify(Array.from(dirtyFiles)));
    } catch (error) {
      console.error('Failed to save dirty files to localStorage:', error);
    }
  }, [dirtyFiles, isInitialized]);

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

  const closeFile = useCallback((path: string) => {
    setOpenedFiles(prev => {
      const next = prev.filter(f => f.path !== path);
      setActiveFilePath(prevActive => (prevActive === path ? (next[next.length - 1]?.path ?? null) : prevActive));
      return next;
    });

    setFileEditStates(prev => {
      const next = new Map(prev);
      next.delete(path);
      persistFileEditStates(next);
      return next;
    });

    setDirtyFiles(prev => {
      const next = new Set(prev);
      next.delete(path);
      persistDirtyFiles(next);
      return next;
    });
  }, [persistDirtyFiles, persistFileEditStates]);

  const handleFileClose = useCallback((path: string) => {
    if (dirtyFiles.has(path)) {
      setPendingClosePath(path);
      setIsCloseDialogOpen(true);
      return;
    }
    closeFile(path);
  }, [closeFile, dirtyFiles]);

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
      const next = new Map(prev);
      next.set(filePath, { content, isDirty });
      persistFileEditStates(next);
      return next;
    });

    setDirtyFiles(prev => {
      const next = new Set(prev);
      if (isDirty) {
        next.add(filePath);
      } else {
        next.delete(filePath);
      }
      persistDirtyFiles(next);
      return next;
    });
  }, [persistDirtyFiles, persistFileEditStates]);

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

  const confirmClose = useCallback(() => {
    if (pendingClosePath) {
      closeFile(pendingClosePath);
    }
    setIsCloseDialogOpen(false);
    setPendingClosePath(null);
  }, [closeFile, pendingClosePath]);

  const cancelClose = useCallback(() => {
    setIsCloseDialogOpen(false);
    setPendingClosePath(null);
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-hidden flex flex-col bg-background w-full">
      {/* Main content */}
      <div className="flex-1 overflow-hidden min-h-0 w-full min-w-0">
        <div className="h-full min-h-0 min-w-0 flex flex-col w-full px-[10%]">
          <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0 min-w-0 w-full">
            <ResizablePanel defaultSize={25} minSize={15} className="border-r flex h-full flex-col overflow-hidden min-w-0">
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
            <ResizablePanel defaultSize={75} minSize={30} className="flex h-full flex-col overflow-hidden min-w-0">
              {openedFiles.length > 0 && (
                <div className="shrink-0 w-full min-w-0">
                  <FileTabs
                    files={openedFiles}
                    activeFile={activeFilePath}
                    dirtyFiles={dirtyFiles}
                    onTabChange={handleTabChange}
                    onTabClose={handleFileClose}
                  />
                </div>
              )}
              <div className="flex-1 min-h-0 min-w-0 w-full overflow-hidden">
                {openedFiles.length > 0 && activeFilePath ? (
                  <FileViewer
                    filePath={activeFilePath}
                    onFileDataLoad={handleFileDataLoad}
                    onContentChange={handleContentChange}
                    initialEditedContent={fileEditStates.get(activeFilePath)?.content}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                    Select a file from the tree to view
                  </div>
                )}
              </div>
              <FileFooterBar filePath={activeFilePath} mimeType={activeFileMimeType} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>

      <AlertDialog open={isCloseDialogOpen} onOpenChange={setIsCloseDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Closing this tab will discard them. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelClose}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmClose}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
