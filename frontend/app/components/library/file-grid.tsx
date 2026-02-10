import { useState, useEffect, useCallback, useRef } from 'react';
import { FolderPlus } from 'lucide-react';
import { api } from '~/lib/api';
import { useLibraryNotifications } from '~/hooks/use-notifications';
import type { PendingInboxItem } from '~/lib/send-queue/types';
import { Input } from '~/components/ui/input';
import {
  type FileNode,
  getNodeName,
  sortNodes,
  buildVirtualNodes,
  getFolderUploadStatus,
} from './library-utils';
import { GridItem } from './grid-item';
import { BreadcrumbNav } from './breadcrumb-nav';

interface FileGridProps {
  onFileOpen: (path: string, name: string) => void;
  selectedFilePath?: string | null;
  onFileDeleted?: (path: string) => void;
  onFileRenamed?: (oldPath: string, newPath: string) => void;
  onFileMoved?: (oldPath: string, newPath: string) => void;
  createFolderTrigger?: number;
}

export function FileGrid({
  onFileOpen,
  selectedFilePath,
  onFileDeleted,
  onFileRenamed,
  onFileMoved,
  createFolderTrigger,
}: FileGridProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [children, setChildren] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const [pendingUploads, setPendingUploads] = useState<PendingInboxItem[]>([]);

  // Reference to upload manager for cleanup
  const uploadManagerRef = useRef<Awaited<ReturnType<typeof import('~/lib/send-queue/upload-queue-manager').getUploadQueueManager>> | null>(null);

  // Core loading function
  const loadChildren = useCallback(async (showLoadingState = true) => {
    if (showLoadingState) setIsLoading(true);
    try {
      const url = currentPath
        ? `/api/library/tree?path=${encodeURIComponent(currentPath)}`
        : '/api/library/tree';
      const response = await api.get(url);
      const data = await response.json();
      setChildren(data.children || []);
    } catch (error) {
      console.error('Failed to load directory:', error);
    } finally {
      setIsLoading(false);
    }
  }, [currentPath]);

  // Debounced refresh
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedLoad = useCallback(() => {
    if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
    loadTimeoutRef.current = setTimeout(() => {
      loadTimeoutRef.current = null;
      loadChildren(false);
    }, 100);
  }, [loadChildren]);

  useEffect(() => {
    return () => {
      if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
    };
  }, []);

  // Load when path changes
  useEffect(() => {
    loadChildren(true);
  }, [loadChildren]);

  // Subscribe to upload progress
  useEffect(() => {
    let unsubscribeProgress: (() => void) | undefined;

    const setupUploadTracking = async () => {
      const { getUploadQueueManager } = await import('~/lib/send-queue/upload-queue-manager');
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();
      uploadManagerRef.current = uploadManager;

      unsubscribeProgress = uploadManager.onProgress((items) => {
        const libraryUploads = items.filter(item => item.destination !== 'inbox' && item.destination !== undefined);
        setPendingUploads(libraryUploads);
      });
    };

    setupUploadTracking();
    return () => { unsubscribeProgress?.(); };
  }, []);

  // Clean up completed uploads
  useEffect(() => {
    const hasActiveUploads = pendingUploads.some(
      item => item.status === 'saved' || item.status === 'uploading'
    );
    const completedUploads = pendingUploads.filter(item => item.status === 'uploaded');

    if (hasActiveUploads || completedUploads.length === 0 || !uploadManagerRef.current) return;

    const timer = setTimeout(() => {
      if (!uploadManagerRef.current) return;
      const pathsToDelete = new Set<string>();
      for (const item of completedUploads) {
        if (item.serverPath) pathsToDelete.add(item.serverPath);
      }
      if (pathsToDelete.size > 0) {
        uploadManagerRef.current.deleteCompletedUploads(pathsToDelete);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [pendingUploads]);

  // SSE notifications
  const handleLibraryChange = useCallback((_path: string, _operation: string) => {
    debouncedLoad();
  }, [debouncedLoad]);

  useLibraryNotifications({
    onLibraryChange: handleLibraryChange,
    enabled: true,
  });

  // External trigger for folder creation
  useEffect(() => {
    if (createFolderTrigger && createFolderTrigger > 0) {
      setIsCreatingFolder(true);
    }
  }, [createFolderTrigger]);

  useEffect(() => {
    if (isCreatingFolder && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
    }
  }, [isCreatingFolder]);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) {
      setIsCreatingFolder(false);
      return;
    }

    try {
      const response = await api.post('/api/library/folder', { path: currentPath, name: newFolderName.trim() });
      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to create folder');
        return;
      }
      loadChildren(false);
    } catch (error) {
      console.error('Failed to create folder:', error);
      alert('Failed to create folder');
    } finally {
      setIsCreatingFolder(false);
      setNewFolderName('');
    }
  };

  const handleNewFolderKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreateFolder();
    } else if (e.key === 'Escape') {
      setIsCreatingFolder(false);
      setNewFolderName('');
    }
  };

  const handleNavigate = (path: string) => {
    setCurrentPath(path);
  };

  const handleItemClick = (node: FileNode, fullPath: string) => {
    if (node.type === 'folder') {
      setCurrentPath(fullPath);
    } else {
      onFileOpen(fullPath, getNodeName(node));
    }
  };

  const handleFileDeleted = useCallback((path: string) => {
    onFileDeleted?.(path);
    loadChildren(false);
  }, [onFileDeleted, loadChildren]);

  const handleFileRenamed = useCallback((oldPath: string, newPath: string) => {
    onFileRenamed?.(oldPath, newPath);
    loadChildren(false);
  }, [onFileRenamed, loadChildren]);

  // Merge real children with virtual upload nodes
  const realChildPaths = new Set(children.map(c => c.path));
  const virtualChildren = buildVirtualNodes(pendingUploads, currentPath, realChildPaths);

  // Annotate real folders with upload status
  const annotatedChildren = children.map(child => {
    if (child.type === 'folder') {
      const fullChildPath = currentPath ? `${currentPath}/${child.path}` : child.path;
      const status = getFolderUploadStatus(fullChildPath, pendingUploads);
      if (status) {
        return { ...child, uploadStatus: status };
      }
    }
    return child;
  });

  const allNodes = sortNodes([...virtualChildren, ...annotatedChildren]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Breadcrumb navigation */}
      <div className="shrink-0 px-3 py-2 border-b">
        <BreadcrumbNav currentPath={currentPath} onNavigate={handleNavigate} />
      </div>

      {/* Grid content */}
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && children.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
            Loading...
          </div>
        ) : allNodes.length === 0 && !isCreatingFolder ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-sm text-muted-foreground">
            <p>Empty folder</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1">
            {allNodes.map((node) => {
              const fullPath = currentPath
                ? `${currentPath}/${node.path}`
                : node.path;

              return (
                <GridItem
                  key={node.path + (node.uploadStatus ? '-virtual' : '')}
                  node={node}
                  fullPath={fullPath}
                  isSelected={fullPath === selectedFilePath}
                  onClick={() => handleItemClick(node, fullPath)}
                  onRefresh={() => loadChildren(false)}
                  onFileDeleted={handleFileDeleted}
                  onFileRenamed={handleFileRenamed}
                />
              );
            })}

            {/* Inline new folder creation */}
            {isCreatingFolder && (
              <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-accent/50">
                <FolderPlus className="w-10 h-10 text-muted-foreground" />
                <Input
                  ref={newFolderInputRef}
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onBlur={handleCreateFolder}
                  onKeyDown={handleNewFolderKeyDown}
                  placeholder="Folder name"
                  className="h-6 py-0 px-1 text-xs text-center"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
