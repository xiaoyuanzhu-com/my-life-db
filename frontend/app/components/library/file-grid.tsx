import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { FolderPlus } from 'lucide-react';
import { api } from '~/lib/api';
import { useLibraryNotifications } from '~/hooks/use-notifications';
import type { PendingInboxItem } from '~/lib/send-queue/types';
import { parseApiError } from '~/lib/errors';
import { useErrorMessage } from '~/hooks/use-error-message';
import { Input } from '~/components/ui/input';
import {
  type FileNode,
  getNodeName,
  sortNodes,
  buildVirtualNodes,
  getFolderUploadStatus,
} from './library-utils';
import { GridItem } from './grid-item';

interface FileGridProps {
  onFileOpen: (path: string, name: string) => void;
  selectedFilePath?: string | null;
  onFileDeleted?: (path: string) => void;
  onFileRenamed?: (oldPath: string, newPath: string) => void;
  onFileMoved?: (oldPath: string, newPath: string) => void;
  createFolderTrigger?: number;
  /** Optional action callbacks for integrated toolbar (mobile) */
  onUploadFile?: () => void;
  onUploadFolder?: () => void;
  /** Controlled path state — when provided, FileGrid does not manage its own path */
  currentPath?: string;
  onNavigate?: (path: string) => void;
}

export function FileGrid({
  onFileOpen,
  selectedFilePath,
  onFileDeleted,
  onFileRenamed,
  onFileMoved: _onFileMoved,
  createFolderTrigger,
  onUploadFile,
  onUploadFolder,
  currentPath: controlledPath,
  onNavigate: controlledNavigate,
}: FileGridProps) {
  const [internalPath, setInternalPath] = useState('');
  const currentPath = controlledPath ?? internalPath;
  const [children, setChildren] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const [pendingUploads, setPendingUploads] = useState<PendingInboxItem[]>([]);
  // Shared file inputs for targeted uploads (from context menu)
  const targetFileInputRef = useRef<HTMLInputElement>(null);
  const targetFolderInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetPathRef = useRef<string>('');
  const tErr = useErrorMessage();

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
        const apiErr = await parseApiError(response);
        alert(tErr(apiErr));
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

  // Context menu: upload files to a specific folder
  const handleUploadFileTo = useCallback((targetPath: string) => {
    uploadTargetPathRef.current = targetPath;
    targetFileInputRef.current?.click();
  }, []);

  // Context menu: upload folder to a specific folder
  const handleUploadFolderTo = useCallback((targetPath: string) => {
    uploadTargetPathRef.current = targetPath;
    targetFolderInputRef.current?.click();
  }, []);

  const handleTargetFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const targetPath = uploadTargetPathRef.current;
    const fileArray = Array.from(files);

    try {
      const { getUploadQueueManager } = await import('~/lib/send-queue/upload-queue-manager');
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();

      const batch = fileArray.map(file => ({ file, destination: targetPath }));
      await uploadManager.enqueueBatch(batch);
    } catch (error) {
      console.error('Failed to upload files:', error);
      toast.error(`Failed to upload files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    e.target.value = '';
  };

  const handleTargetFolderInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const targetPath = uploadTargetPathRef.current;
    const fileArray = Array.from(files);

    try {
      const { getUploadQueueManager } = await import('~/lib/send-queue/upload-queue-manager');
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();

      const batch = fileArray.map(file => {
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const pathParts = relativePath.split('/');
        pathParts.pop();
        const relativeDir = pathParts.join('/');
        const destination = targetPath
          ? relativeDir ? `${targetPath}/${relativeDir}` : targetPath
          : relativeDir;
        return { file, destination };
      });

      await uploadManager.enqueueBatch(batch);
    } catch (error) {
      console.error('Failed to upload folder:', error);
      toast.error(`Failed to upload folder: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    e.target.value = '';
  };

  // Context menu: create new folder inside a specific folder
  const handleNewFolderIn = useCallback(async (parentPath: string) => {
    const folderName = prompt('New folder name:');
    if (!folderName?.trim()) return;

    try {
      const response = await api.post('/api/library/folder', { path: parentPath, name: folderName.trim() });
      if (!response.ok) {
        const apiErr = await parseApiError(response);
        alert(tErr(apiErr));
        return;
      }
      loadChildren(false);
    } catch (error) {
      console.error('Failed to create folder:', error);
      alert('Failed to create folder');
    }
  }, [loadChildren, tErr]);

  const navigateTo = controlledNavigate ?? setInternalPath;

  const handleNavigate = (path: string) => {
    navigateTo(path);
  };

  const handleItemClick = (node: FileNode, fullPath: string) => {
    if (node.type === 'folder') {
      navigateTo(fullPath);
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
      {/* Hidden file inputs for targeted uploads */}
      <input
        ref={targetFileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleTargetFileInputChange}
      />
      <input
        ref={targetFolderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleTargetFolderInputChange}
        {...{ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>}
      />

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
                  onUploadFileTo={handleUploadFileTo}
                  onUploadFolderTo={handleUploadFolderTo}
                  onNewFolderIn={handleNewFolderIn}
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
