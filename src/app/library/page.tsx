'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileTree } from '@/components/library/FileTree';
import { FileViewer } from '@/components/library/FileViewer';
import { FileTabs } from '@/components/library/FileTabs';

export interface OpenedFile {
  path: string;
  name: string;
}

export default function LibraryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [openedFiles, setOpenedFiles] = useState<OpenedFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [isInitialized, setIsInitialized] = useState(false);

  // Load state from localStorage on mount
  useEffect(() => {
    console.log('[Library] Loading state from localStorage...');
    try {
      const savedOpenedFiles = localStorage.getItem('library:openedFiles');
      const savedActiveFile = localStorage.getItem('library:activeFile');
      const savedExpandedFolders = localStorage.getItem('library:expandedFolders');

      console.log('[Library] Raw localStorage values:', {
        savedOpenedFiles,
        savedActiveFile,
        savedExpandedFolders,
      });

      if (savedOpenedFiles) {
        const files = JSON.parse(savedOpenedFiles);
        console.log('[Library] Restoring opened files:', files);
        setOpenedFiles(files);
      } else {
        console.log('[Library] No saved opened files found');
      }

      if (savedActiveFile) {
        console.log('[Library] Restoring active file:', savedActiveFile);
        setActiveFilePath(savedActiveFile);
      } else {
        console.log('[Library] No saved active file found');
      }

      if (savedExpandedFolders) {
        const folders = new Set(JSON.parse(savedExpandedFolders));
        console.log('[Library] Restoring expanded folders:', Array.from(folders));
        setExpandedFolders(folders);
      } else {
        console.log('[Library] No saved expanded folders found');
      }
    } catch (error) {
      console.error('[Library] Failed to load state from localStorage:', error);
    } finally {
      // Mark as initialized after loading from localStorage
      setIsInitialized(true);
      console.log('[Library] Initialization complete');
    }
  }, []);

  // Save opened files to localStorage (skip on initial mount)
  useEffect(() => {
    if (!isInitialized) return;
    try {
      console.log('[Library] Saving opened files to localStorage:', openedFiles);
      localStorage.setItem('library:openedFiles', JSON.stringify(openedFiles));
    } catch (error) {
      console.error('[Library] Failed to save opened files to localStorage:', error);
    }
  }, [openedFiles, isInitialized]);

  // Save active file to localStorage (skip on initial mount)
  useEffect(() => {
    if (!isInitialized) return;
    try {
      if (activeFilePath) {
        console.log('[Library] Saving active file to localStorage:', activeFilePath);
        localStorage.setItem('library:activeFile', activeFilePath);
      } else {
        console.log('[Library] Removing active file from localStorage');
        localStorage.removeItem('library:activeFile');
      }
    } catch (error) {
      console.error('[Library] Failed to save active file to localStorage:', error);
    }
  }, [activeFilePath, isInitialized]);

  // Save expanded folders to localStorage (skip on initial mount)
  useEffect(() => {
    if (!isInitialized) return;
    try {
      const foldersArray = Array.from(expandedFolders);
      console.log('[Library] Saving expanded folders to localStorage:', foldersArray);
      localStorage.setItem('library:expandedFolders', JSON.stringify(foldersArray));
    } catch (error) {
      console.error('[Library] Failed to save expanded folders to localStorage:', error);
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

      // Check if file is already open
      const isAlreadyOpen = openedFiles.some(f => f.path === filePath);

      if (!isAlreadyOpen) {
        // Add to opened files
        setOpenedFiles(prev => [...prev, { path: filePath, name: fileName }]);
      }

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
    console.log('[Library] Opening file:', { path, name });
    // Add to opened files if not already open
    if (!openedFiles.some(f => f.path === path)) {
      const newOpenedFiles = [...openedFiles, { path, name }];
      console.log('[Library] Adding to opened files. New list:', newOpenedFiles);
      setOpenedFiles(newOpenedFiles);
    } else {
      console.log('[Library] File already open, just switching to it');
    }
    setActiveFilePath(path);

    // Auto-expand parent folders to keep the file visible
    expandParentFolders(path);
  };

  const handleFileClose = (path: string) => {
    console.log('[Library] Closing file:', path);
    const newOpenedFiles = openedFiles.filter(f => f.path !== path);
    console.log('[Library] New opened files after close:', newOpenedFiles);
    setOpenedFiles(newOpenedFiles);

    // If closing the active file, switch to the last opened file
    if (activeFilePath === path) {
      if (newOpenedFiles.length > 0) {
        const newActive = newOpenedFiles[newOpenedFiles.length - 1].path;
        console.log('[Library] Switching active file to:', newActive);
        setActiveFilePath(newActive);
      } else {
        console.log('[Library] No files left, clearing active file');
        setActiveFilePath(null);
      }
    }
  };

  const handleTabChange = (path: string) => {
    console.log('[Library] Changing active tab to:', path);
    setActiveFilePath(path);
  };

  const handleToggleFolder = (path: string, isExpanded: boolean) => {
    console.log('[Library] Toggling folder:', { path, isExpanded });
    const newExpandedFolders = new Set(expandedFolders);
    if (isExpanded) {
      newExpandedFolders.add(path);
    } else {
      newExpandedFolders.delete(path);
    }
    console.log('[Library] New expanded folders:', Array.from(newExpandedFolders));
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
                selectedFilePath={activeFilePath}
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
