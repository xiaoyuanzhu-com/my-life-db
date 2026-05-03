import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FolderPlus, ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from '~/lib/utils';
import { api } from '~/lib/api';
import { useLibraryNotifications } from '~/hooks/use-notifications';
import type { PendingInboxItem } from '~/lib/send-queue/types';
import { parseApiError } from '~/lib/errors';
import { useErrorMessage } from '~/hooks/use-error-message';
import { Input } from '~/components/ui/input';
import {
  type FileNode,
  type SortKey,
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
  /** Visual layout — controlled by parent's More menu. Default: 'grid' */
  viewMode?: 'grid' | 'list';
  /** Sort key — controlled by parent's More menu. Default: 'name' */
  sortKey?: SortKey;
  /** Callback when the user changes sort key (e.g. clicking a list header) */
  onSortChange?: (key: SortKey) => void;
}

export function FileGrid({
  onFileOpen,
  selectedFilePath,
  onFileDeleted,
  onFileRenamed,
  onFileMoved: _onFileMoved,
  createFolderTrigger,
  onUploadFile: _onUploadFile,
  onUploadFolder: _onUploadFolder,
  currentPath: controlledPath,
  onNavigate: controlledNavigate,
  viewMode = 'grid',
  sortKey = 'name',
  onSortChange,
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
  const { t } = useTranslation(['data', 'common']);
  const tErr = useErrorMessage();

  // Reference to upload manager for cleanup
  const uploadManagerRef = useRef<Awaited<ReturnType<typeof import('~/lib/send-queue/upload-queue-manager').getUploadQueueManager>> | null>(null);

  // Core loading function
  const loadChildren = useCallback(async (showLoadingState = true) => {
    if (showLoadingState) setIsLoading(true);
    try {
      const url = currentPath
        ? `/api/data/tree?path=${encodeURIComponent(currentPath)}`
        : '/api/data/tree';
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
      const response = await api.post('/api/data/folders', { parent: currentPath, name: newFolderName.trim() });
      if (!response.ok) {
        const apiErr = await parseApiError(response);
        alert(tErr(apiErr));
        return;
      }
      loadChildren(false);
    } catch (error) {
      console.error('Failed to create folder:', error);
      alert(t('data:errors.createFolderFailed'));
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
      toast.error(t('data:upload.filesFailed', { error: error instanceof Error ? error.message : 'Unknown error' }));
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
      toast.error(t('data:upload.folderFailed', { error: error instanceof Error ? error.message : 'Unknown error' }));
    }

    e.target.value = '';
  };

  // Context menu: create new folder inside a specific folder
  const handleNewFolderIn = useCallback(async (parentPath: string) => {
    const folderName = prompt('New folder name:');
    if (!folderName?.trim()) return;

    try {
      const response = await api.post('/api/data/folders', { parent: parentPath, name: folderName.trim() });
      if (!response.ok) {
        const apiErr = await parseApiError(response);
        alert(tErr(apiErr));
        return;
      }
      loadChildren(false);
    } catch (error) {
      console.error('Failed to create folder:', error);
      alert(t('data:errors.createFolderFailed'));
    }
  }, [loadChildren, tErr]);

  const navigateTo = controlledNavigate ?? setInternalPath;

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

  const allNodes = sortNodes([...virtualChildren, ...annotatedChildren], sortKey);


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
            {t('common:states.loading')}
          </div>
        ) : allNodes.length === 0 && !isCreatingFolder ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-sm text-muted-foreground">
            <p>{t('data:library.emptyFolder')}</p>
          </div>
        ) : (
          <div
            className={
              viewMode === 'list'
                ? 'flex flex-col gap-0.5'
                : 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1'
            }
          >
            {viewMode === 'list' && (
              <div className="sticky top-[-0.5rem] -mx-2 -mt-2 px-4 pt-2 pb-1 bg-background z-10 flex flex-row items-center gap-3 text-xs font-medium text-muted-foreground">
                <div className="w-8 h-8 shrink-0" aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => onSortChange?.('name')}
                  className={cn(
                    'flex-1 min-w-0 text-left flex items-center gap-1 hover:text-foreground transition-colors',
                    sortKey === 'name' && 'text-foreground',
                  )}
                >
                  <span className="truncate">{t('data:headers.name', 'Name')}</span>
                  {sortKey === 'name' && <ArrowUp className="w-3 h-3 shrink-0" />}
                </button>
                <button
                  type="button"
                  onClick={() => onSortChange?.('modifiedAt')}
                  className={cn(
                    'hidden sm:flex w-24 shrink-0 items-center justify-end gap-1 hover:text-foreground transition-colors',
                    sortKey === 'modifiedAt' && 'text-foreground',
                  )}
                >
                  <span className="truncate">{t('data:headers.modified', 'Modified')}</span>
                  {sortKey === 'modifiedAt' && <ArrowDown className="w-3 h-3 shrink-0" />}
                </button>
                <button
                  type="button"
                  onClick={() => onSortChange?.('createdAt')}
                  className={cn(
                    'hidden md:flex w-24 shrink-0 items-center justify-end gap-1 hover:text-foreground transition-colors',
                    sortKey === 'createdAt' && 'text-foreground',
                  )}
                >
                  <span className="truncate">{t('data:headers.created', 'Created')}</span>
                  {sortKey === 'createdAt' && <ArrowDown className="w-3 h-3 shrink-0" />}
                </button>
                <span className="hidden sm:inline w-16 text-right shrink-0">
                  {t('data:headers.size', 'Size')}
                </span>
              </div>
            )}
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
                  variant={viewMode}
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
              viewMode === 'list' ? (
                <div className="flex flex-row items-center gap-3 px-2 py-1.5 rounded-md bg-accent/50">
                  <FolderPlus className="w-7 h-7 text-muted-foreground shrink-0" />
                  <Input
                    ref={newFolderInputRef}
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onBlur={handleCreateFolder}
                    onKeyDown={handleNewFolderKeyDown}
                    placeholder={t('data:library.folderNamePlaceholder')}
                    className="h-6 py-0 px-1 text-xs flex-1"
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 p-3 rounded-lg bg-accent/50">
                  <FolderPlus className="w-10 h-10 text-muted-foreground" />
                  <Input
                    ref={newFolderInputRef}
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onBlur={handleCreateFolder}
                    onKeyDown={handleNewFolderKeyDown}
                    placeholder={t('data:library.folderNamePlaceholder')}
                    className="h-6 py-0 px-1 text-xs text-center"
                  />
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
