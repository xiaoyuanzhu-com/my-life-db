import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, Folder, File, FileText, Image, Film, Music, FileCode, Pencil, Trash2, FolderPlus, Copy, Loader2, CircleAlert } from 'lucide-react';
import { cn } from '~/lib/utils';
import type { PendingInboxItem } from '~/lib/send-queue/types';
import { api } from '~/lib/api';
import { useLibraryNotifications } from '~/hooks/use-notifications';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '~/components/ui/context-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Input } from '~/components/ui/input';

interface FileNode {
  path: string;
  type: 'file' | 'folder';
  size?: number;
  modifiedAt?: string;
  children?: FileNode[];
  uploadStatus?: 'pending' | 'uploading' | 'error';
  uploadProgress?: number;
}

function getFolderUploadStatus(
  folderPath: string,
  pendingUploads: PendingInboxItem[]
): 'pending' | 'error' | undefined {
  // Find uploads where destination starts with or equals this folder path
  const relevantUploads = pendingUploads.filter(item => {
    const dest = item.destination || '';
    return dest === folderPath || dest.startsWith(folderPath + '/');
  });

  if (relevantUploads.length === 0) return undefined;
  if (relevantUploads.some(u => u.errorMessage)) return 'error';
  return 'pending'; // has pending or uploading
}

function getFileUploadStatus(item: PendingInboxItem): 'pending' | 'uploading' | 'error' {
  if (item.errorMessage) return 'error';
  if (item.status === 'uploading') return 'uploading';
  return 'pending';
}

function buildVirtualNodes(
  pendingUploads: PendingInboxItem[],
  basePath: string,
  realNodePaths: Set<string>
): FileNode[] {
  const virtualFolders = new Map<string, PendingInboxItem[]>();
  const virtualFiles: FileNode[] = [];

  for (const item of pendingUploads) {
    const dest = item.destination || '';

    // Skip if destination doesn't match basePath context
    if (basePath) {
      if (!dest.startsWith(basePath + '/') && dest !== basePath) continue;
    }

    // Get relative path from basePath
    const relativeDest = basePath ? dest.slice(basePath.length + 1) : dest;

    // If destination equals basePath, this file goes directly here
    if (dest === basePath || relativeDest === '') {
      // Skip if file already exists in real nodes
      if (realNodePaths.has(item.filename)) continue;

      virtualFiles.push({
        path: item.filename,
        type: 'file',
        size: item.size,
        uploadStatus: getFileUploadStatus(item),
        uploadProgress: item.uploadProgress,
      });
      continue;
    }

    // Otherwise, get the first path segment (folder name)
    const firstSegment = relativeDest.split('/')[0];
    if (!firstSegment) continue;

    // Skip if this folder already exists in real nodes
    if (realNodePaths.has(firstSegment)) continue;

    // Group by first segment for virtual folders
    const existing = virtualFolders.get(firstSegment);
    if (existing) {
      existing.push(item);
    } else {
      virtualFolders.set(firstSegment, [item]);
    }
  }

  // Convert virtual folder map to FileNode array
  const virtualFolderNodes: FileNode[] = Array.from(virtualFolders.entries()).map(
    ([name, items]) => {
      const hasError = items.some(i => i.errorMessage);
      return {
        path: name,
        type: 'folder' as const,
        uploadStatus: hasError ? 'error' : 'pending',
      };
    }
  );

  return [...virtualFolderNodes, ...virtualFiles];
}

// Sort nodes: folders first, then files, alphabetically within each group
function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    // Folders come before files
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1;
    }
    // Alphabetical within same type
    return a.path.localeCompare(b.path);
  });
}

// Derive name from path
function getNodeName(node: FileNode): string {
  return node.path.split('/').pop() || node.path;
}

interface FileTreeProps {
  onFileOpen: (path: string, name: string) => void;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string, isExpanded: boolean) => void;
  selectedFilePath?: string | null;
  onFileDeleted?: (path: string) => void;
  onFileRenamed?: (oldPath: string, newPath: string) => void;
  onFileMoved?: (oldPath: string, newPath: string) => void;
  createFolderTrigger?: number;
}

interface TreeNodeProps {
  node: FileNode;
  parentPath: string; // Parent's full path, empty string for root
  level: number;
  onFileOpen: (path: string, name: string) => void;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string, isExpanded: boolean) => void;
  selectedFilePath?: string | null;
  onRefresh: () => void;
  onFileDeleted?: (path: string) => void;
  onFileRenamed?: (oldPath: string, newPath: string) => void;
  onFileMoved?: (oldPath: string, newPath: string) => void;
  draggedItem: FileNode | null;
  setDraggedItem: (node: FileNode | null) => void;
  dropTarget: string | null;
  setDropTarget: (path: string | null) => void;
  onExternalFileDrop: (entries: FileSystemEntry[], targetPath: string) => Promise<void>;
  /** All pending uploads - filtered by each TreeNode based on its path */
  allPendingUploads: PendingInboxItem[];
  /** Trigger to reload children (incremented on SSE refresh) */
  refreshTrigger: number;
}

function getFileIcon(filename: string) {
  const ext = filename.toLowerCase().split('.').pop();

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  const videoExts = ['mp4', 'webm', 'mov', 'avi'];
  const audioExts = ['mp3', 'wav', 'ogg', 'm4a'];
  const codeExts = ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cpp', 'c', 'go', 'rs'];

  if (ext === 'md' || ext === 'txt') return FileText;
  if (imageExts.includes(ext || '')) return Image;
  if (videoExts.includes(ext || '')) return Film;
  if (audioExts.includes(ext || '')) return Music;
  if (codeExts.includes(ext || '')) return FileCode;
  return File;
}

function TreeNode({
  node,
  parentPath,
  level,
  onFileOpen,
  expandedFolders,
  onToggleFolder,
  selectedFilePath,
  onRefresh,
  onFileDeleted,
  onFileRenamed,
  onFileMoved,
  draggedItem,
  setDraggedItem,
  dropTarget,
  setDropTarget,
  onExternalFileDrop,
  allPendingUploads,
  refreshTrigger,
}: TreeNodeProps) {
  const [children, setChildren] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(getNodeName(node));
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute full path from parent path and node name
  const fullPath = parentPath ? `${parentPath}/${node.path}` : node.path;

  const isExpanded = expandedFolders.has(fullPath);
  const isSelected = node.type === 'file' && fullPath === selectedFilePath;
  const isDropTarget = dropTarget === fullPath && node.type === 'folder';
  const isDragging = draggedItem?.path === fullPath;

  // Calculate folder status from pending uploads
  const folderStatus = node.type === 'folder'
    ? (node.uploadStatus || getFolderUploadStatus(fullPath, allPendingUploads))
    : undefined;

  // File status comes directly from node
  const fileStatus = node.type === 'file' ? node.uploadStatus : undefined;

  // Combined status for styling
  const uploadStatus = folderStatus || fileStatus;
  const isUploading = uploadStatus === 'pending' || uploadStatus === 'uploading';
  const hasError = uploadStatus === 'error';
  const isFile = node.type === 'file';

  const loadChildren = useCallback(async (isInitialLoad = false) => {
    if (isLoading) return;

    // Only show loading state on initial load, not refreshes
    if (isInitialLoad) {
      setIsLoading(true);
    }
    try {
      const response = await api.get(`/api/library/tree?path=${encodeURIComponent(fullPath)}`);
      const data = await response.json();
      setChildren(data.children || []);
    } catch (error) {
      console.error('Failed to load folder children:', error);
    } finally {
      setIsLoading(false);
    }
    // Note: isLoading intentionally excluded to prevent infinite loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullPath]);

  useEffect(() => {
    if (node.type === 'folder' && isExpanded && children.length === 0) {
      loadChildren(true); // Initial load - show loading state
    }
  }, [isExpanded, node.type, children.length, loadChildren]);

  // Reload children when SSE triggers a refresh (for expanded folders)
  const prevRefreshTrigger = useRef(refreshTrigger);
  useEffect(() => {
    if (prevRefreshTrigger.current !== refreshTrigger) {
      prevRefreshTrigger.current = refreshTrigger;
      if (node.type === 'folder' && isExpanded) {
        loadChildren(false); // Refresh - don't show loading state
      }
    }
  }, [refreshTrigger, node.type, isExpanded, loadChildren]);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const handleToggle = () => {
    if (node.type === 'folder') {
      onToggleFolder(fullPath, !isExpanded);
    }
  };

  const handleClick = () => {
    if (isRenaming) return;
    if (node.type === 'file') {
      onFileOpen(fullPath, getNodeName(node));
    } else {
      handleToggle();
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startRename();
  };

  const startRename = () => {
    setRenameValue(getNodeName(node));
    setIsRenaming(true);
  };

  const handleRenameSubmit = async () => {
    if (!renameValue.trim() || renameValue === getNodeName(node)) {
      setIsRenaming(false);
      return;
    }

    try {
      const response = await api.post('/api/library/rename', { path: fullPath, newName: renameValue.trim() });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to rename');
        return;
      }

      const result = await response.json();
      onFileRenamed?.(fullPath, result.newPath);
      onRefresh();
    } catch (error) {
      console.error('Failed to rename:', error);
      alert('Failed to rename');
    } finally {
      setIsRenaming(false);
    }
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setIsRenaming(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const response = await api.delete(`/api/library/file?path=${encodeURIComponent(fullPath)}`);

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to delete');
        return;
      }

      onFileDeleted?.(fullPath);
      onRefresh();
    } catch (error) {
      console.error('Failed to delete:', error);
      alert('Failed to delete');
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(fullPath);
    } catch (error) {
      console.error('Failed to copy path:', error);
    }
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    // Store node with fullPath for drag operations
    setDraggedItem({ ...node, path: fullPath });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', fullPath);
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
    setDropTarget(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Check if dragging files from outside (has files but no dragged item from tree)
    const hasFiles = e.dataTransfer.types.includes('Files');

    if (node.type === 'folder') {
      if (hasFiles && !draggedItem) {
        // External files being dragged over folder
        e.dataTransfer.dropEffect = 'copy';
        setDropTarget(fullPath);
      } else if (draggedItem && draggedItem.path !== fullPath) {
        // Internal drag - prevent dropping into self or children
        if (!draggedItem.path.startsWith(fullPath + '/')) {
          e.dataTransfer.dropEffect = 'move';
          setDropTarget(fullPath);
        }
      }
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dropTarget === fullPath) {
      setDropTarget(null);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);

    if (node.type !== 'folder') {
      return;
    }

    // Check if dropping external files
    // Extract entries synchronously before any async operations (DataTransfer data is cleared after event)
    const entries: FileSystemEntry[] = [];
    const items = e.dataTransfer.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          entries.push(entry);
        }
      }
    }

    if (entries.length > 0) {
      await onExternalFileDrop(entries, fullPath);
      return;
    }

    // Handle internal drag and drop
    if (!draggedItem || draggedItem.path === fullPath) {
      return;
    }

    // Prevent dropping into self or children
    if (draggedItem.path.startsWith(fullPath + '/')) {
      return;
    }

    try {
      const response = await api.post('/api/library/move', { path: draggedItem.path, targetPath: fullPath });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to move');
        return;
      }

      const result = await response.json();
      onFileMoved?.(draggedItem.path, result.newPath);
      onRefresh();
    } catch (error) {
      console.error('Failed to move:', error);
      alert('Failed to move');
    }

    setDraggedItem(null);
  };

  // Long press for mobile
  const handleTouchStart = () => {
    longPressTimer.current = setTimeout(() => {
      // Context menu will open on long press via native browser behavior
    }, 500);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const Icon = node.type === 'folder' ? Folder : getFileIcon(getNodeName(node));
  const paddingLeft = level * 12 + 8;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={`flex items-center gap-1 px-2 py-1 cursor-pointer group ${
              isSelected ? 'bg-accent' : ''
            } ${isDropTarget ? 'bg-accent/50 ring-1 ring-primary' : ''} ${
              isDragging ? 'opacity-50' : ''
            } hover:bg-accent`}
            style={{ paddingLeft: `${paddingLeft}px` }}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            draggable={!isRenaming}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {node.type === 'folder' && (
              <div className="w-4 h-4 flex items-center justify-center">
                {isExpanded ? (
                  <ChevronDown className="w-3 h-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                )}
              </div>
            )}
            {node.type === 'file' && <div className="w-4" />}
            <Icon className={cn(
              "w-4 h-4 flex-shrink-0",
              isUploading ? "text-muted-foreground" : "text-muted-foreground"
            )} />
            {isRenaming ? (
              <Input
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={handleRenameSubmit}
                onKeyDown={handleRenameKeyDown}
                onClick={(e) => e.stopPropagation()}
                className="h-5 py-0 px-1 text-sm"
              />
            ) : (
              <>
                <span className={cn(
                  "text-sm truncate",
                  isUploading && "text-muted-foreground",
                  hasError && isFile && "text-destructive"
                )} title={getNodeName(node)}>
                  {getNodeName(node)}
                </span>
                {uploadStatus === 'pending' && (
                  <Loader2 className="w-3 h-3 animate-spin text-muted-foreground flex-shrink-0" />
                )}
                {uploadStatus === 'uploading' && (
                  <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
                    {node.uploadProgress ?? 0}%
                  </span>
                )}
                {hasError && (
                  <CircleAlert className="w-3 h-3 text-destructive flex-shrink-0" />
                )}
              </>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={startRename}>
            <Pencil className="w-4 h-4 mr-2" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onClick={handleCopyPath}>
            <Copy className="w-4 h-4 mr-2" />
            Copy Path
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => setShowDeleteDialog(true)} variant="destructive">
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Delete confirmation dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {node.type === 'folder' ? 'folder' : 'file'}?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{getNodeName(node)}"?
              {node.type === 'folder' && ' This will delete all contents inside.'}
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Render children if expanded */}
      {node.type === 'folder' && isExpanded && (
        <div>
          {isLoading && children.length === 0 ? (
            <div className="text-xs text-muted-foreground px-2 py-1" style={{ paddingLeft: `${paddingLeft + 20}px` }}>
              Loading...
            </div>
          ) : (
            (() => {
              // Build set of real child paths
              const realChildPaths = new Set(children.map(c => c.path));

              // Get virtual nodes for this folder level (from pending uploads)
              const virtualChildren = buildVirtualNodes(allPendingUploads, fullPath, realChildPaths);

              // Merge and sort: folders first, then files, alphabetically
              const allChildren = sortNodes([...virtualChildren, ...children]);

              return allChildren.map((child) => (
                <TreeNode
                  key={child.path + (child.uploadStatus ? '-virtual' : '')}
                  node={child}
                  parentPath={fullPath}
                  level={level + 1}
                  onFileOpen={onFileOpen}
                  expandedFolders={expandedFolders}
                  onToggleFolder={onToggleFolder}
                  selectedFilePath={selectedFilePath}
                  onRefresh={onRefresh}
                  onFileDeleted={onFileDeleted}
                  onFileRenamed={onFileRenamed}
                  onFileMoved={onFileMoved}
                  draggedItem={draggedItem}
                  setDraggedItem={setDraggedItem}
                  dropTarget={dropTarget}
                  setDropTarget={setDropTarget}
                  onExternalFileDrop={onExternalFileDrop}
                  allPendingUploads={allPendingUploads}
                  refreshTrigger={refreshTrigger}
                />
              ));
            })()
          )}
        </div>
      )}
    </div>
  );
}

export function FileTree({
  onFileOpen,
  expandedFolders,
  onToggleFolder,
  selectedFilePath,
  onFileDeleted,
  onFileRenamed,
  onFileMoved,
  createFolderTrigger,
}: FileTreeProps) {
  const [rootNodes, setRootNodes] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const [draggedItem, setDraggedItem] = useState<FileNode | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [pendingUploads, setPendingUploads] = useState<PendingInboxItem[]>([]);
  // Trigger to reload children in expanded folders (incremented on SSE refresh)
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Core tree loading function
  const loadRootImpl = useCallback(async () => {
    try {
      const response = await api.get('/api/library/tree');
      const data = await response.json();
      setRootNodes(data.children || []);
    } catch (error) {
      console.error('Failed to load library tree:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Debounced version of loadRoot to prevent excessive API calls
  // when multiple refresh triggers happen in quick succession
  const loadRootTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRoot = useCallback(() => {
    // Cancel any pending refresh
    if (loadRootTimeoutRef.current) {
      clearTimeout(loadRootTimeoutRef.current);
    }
    // Schedule a new refresh after a short delay
    loadRootTimeoutRef.current = setTimeout(() => {
      loadRootTimeoutRef.current = null;
      loadRootImpl();
    }, 100); // 100ms debounce
  }, [loadRootImpl]);

  // Cleanup debounce timeout on unmount
  useEffect(() => {
    return () => {
      if (loadRootTimeoutRef.current) {
        clearTimeout(loadRootTimeoutRef.current);
      }
    };
  }, []);

  // Initial load (immediate, not debounced)
  useEffect(() => {
    loadRootImpl();
  }, [loadRootImpl]);


  // Reference to upload manager for cleanup
  const uploadManagerRef = useRef<Awaited<ReturnType<typeof import('~/lib/send-queue/upload-queue-manager').getUploadQueueManager>> | null>(null);

  // Subscribe to upload progress for showing pending uploads in tree
  useEffect(() => {
    let unsubscribeProgress: (() => void) | undefined;

    const setupUploadTracking = async () => {
      const { getUploadQueueManager } = await import('~/lib/send-queue/upload-queue-manager');
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();
      uploadManagerRef.current = uploadManager;

      unsubscribeProgress = uploadManager.onProgress((items) => {
        // Only show library uploads (not inbox uploads)
        const libraryUploads = items.filter(item => item.destination !== 'inbox' && item.destination !== undefined);
        setPendingUploads(libraryUploads);
      });
    };

    setupUploadTracking();

    return () => {
      unsubscribeProgress?.();
    };
  }, []);

  // Clean up completed uploads after all active uploads finish
  // SSE handles tree refresh, this just removes items from IndexedDB
  useEffect(() => {
    const hasActiveUploads = pendingUploads.some(
      item => item.status === 'saved' || item.status === 'uploading'
    );
    const completedUploads = pendingUploads.filter(item => item.status === 'uploaded');

    // Only clean up when all active uploads are done and there are completed uploads
    if (hasActiveUploads || completedUploads.length === 0 || !uploadManagerRef.current) return;

    // Small delay to ensure SSE has refreshed the tree
    const timer = setTimeout(() => {
      if (!uploadManagerRef.current) return;
      const pathsToDelete = new Set<string>();
      for (const item of completedUploads) {
        if (item.serverPath) {
          pathsToDelete.add(item.serverPath);
        }
      }
      if (pathsToDelete.size > 0) {
        uploadManagerRef.current.deleteCompletedUploads(pathsToDelete);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [pendingUploads]);

  // Subscribe to SSE notifications for library changes
  // This handles ALL refresh cases: upload, delete, rename, move, create folder
  // from any source (this tab, other tabs, external changes)
  const handleLibraryChange = useCallback(() => {
    loadRoot();
    // Also trigger children refresh in expanded folders
    setRefreshTrigger(n => n + 1);
  }, [loadRoot]);

  useLibraryNotifications({
    onLibraryChange: handleLibraryChange,
    enabled: true,
  });

  useEffect(() => {
    if (isCreatingFolder && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
    }
  }, [isCreatingFolder]);

  // External trigger for folder creation
  useEffect(() => {
    if (createFolderTrigger && createFolderTrigger > 0) {
      setIsCreatingFolder(true);
    }
  }, [createFolderTrigger]);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) {
      setIsCreatingFolder(false);
      return;
    }

    try {
      const response = await api.post('/api/library/folder', { path: '', name: newFolderName.trim() });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to create folder');
        return;
      }

      loadRoot();
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

  // Handle drop at root level
  const handleRootDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    const hasFiles = e.dataTransfer.types.includes('Files');

    if (hasFiles && !draggedItem) {
      // External files being dragged over root
      e.dataTransfer.dropEffect = 'copy';
      setDropTarget('');
    } else if (draggedItem) {
      // Internal drag
      e.dataTransfer.dropEffect = 'move';
      setDropTarget('');
    }
  };

  const handleRootDragLeave = () => {
    if (dropTarget === '') {
      setDropTarget(null);
    }
  };

  const handleRootDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropTarget(null);

    // Check if dropping external files
    // Extract entries synchronously before any async operations (DataTransfer data is cleared after event)
    const entries: FileSystemEntry[] = [];
    const items = e.dataTransfer.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          entries.push(entry);
        }
      }
    }

    if (entries.length > 0) {
      await handleExternalFileDrop(entries, '');
      return;
    }

    // Handle internal drag and drop
    if (!draggedItem) return;

    // Don't move if already at root
    if (!draggedItem.path.includes('/')) {
      setDraggedItem(null);
      return;
    }

    try {
      const response = await api.post('/api/library/move', { path: draggedItem.path, targetPath: '' });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to move');
        return;
      }

      const result = await response.json();
      onFileMoved?.(draggedItem.path, result.newPath);
      loadRoot();
    } catch (error) {
      console.error('Failed to move:', error);
      alert('Failed to move');
    }

    setDraggedItem(null);
  };

  /**
   * Recursively traverse file system entries (files and folders)
   * Returns files with their relative paths preserved
   */
  const traverseFileTree = async (
    entry: FileSystemEntry,
    path: string = ''
  ): Promise<Array<{ file: File; relativePath: string }>> => {
    const results: Array<{ file: File; relativePath: string }> = [];

    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      try {
        const file = await new Promise<File>((resolve, reject) => {
          fileEntry.file(resolve, reject);
        });
        const relativePath = path ? `${path}/${file.name}` : file.name;
        results.push({ file, relativePath });
      } catch (err) {
        console.error('[FileTree] Failed to read file entry:', entry.name, err);
      }
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      const dirPath = path ? `${path}/${entry.name}` : entry.name;

      // Read all entries (may need multiple calls for large directories)
      try {
        const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
          const allEntries: FileSystemEntry[] = [];

          function readEntries() {
            reader.readEntries((entries) => {
              if (entries.length === 0) {
                resolve(allEntries);
              } else {
                allEntries.push(...entries);
                // Keep reading (readEntries returns max 100 at a time)
                readEntries();
              }
            }, reject);
          }

          readEntries();
        });

        // Recursively process each entry
        for (const childEntry of entries) {
          const childFiles = await traverseFileTree(childEntry, dirPath);
          results.push(...childFiles);
        }
      } catch (err) {
        console.error('[FileTree] Failed to read directory:', entry.name, err);
      }
    }

    return results;
  };

  const handleExternalFileDrop = async (entries: FileSystemEntry[], targetPath: string) => {
    try {
      const { getUploadQueueManager } = await import('~/lib/send-queue/upload-queue-manager');
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();

      const baseDestination = targetPath;
      const allFiles: Array<{ file: File; relativePath: string }> = [];

      // Recursively traverse all entries (including folders)
      for (const entry of entries) {
        const files = await traverseFileTree(entry);
        allFiles.push(...files);
      }

      if (allFiles.length === 0) {
        return;
      }

      // Build batch with destinations
      const batch = allFiles.map(({ file, relativePath }) => {
        const pathParts = relativePath.split('/');
        pathParts.pop(); // Remove filename from path
        const relativeDir = pathParts.join('/');

        const destination = baseDestination
          ? relativeDir
            ? `${baseDestination}/${relativeDir}`
            : baseDestination
          : relativeDir;

        return { file, destination };
      });

      // Batch enqueue all files at once (single notification)
      await uploadManager.enqueueBatch(batch);
    } catch (error) {
      console.error('[FileTree] Failed to upload files:', error);
      alert(`Failed to upload files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  if (isLoading) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading library...
      </div>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={`py-2 min-h-full ${dropTarget === '' ? 'bg-accent/30' : ''}`}
          onDragOver={handleRootDragOver}
          onDragLeave={handleRootDragLeave}
          onDrop={handleRootDrop}
        >
          {rootNodes.length === 0 && !isCreatingFolder && pendingUploads.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No files in library. Right-click to create a folder.
            </div>
          ) : (
            <>
              {(() => {
                // Build set of real node paths at root level
                const realNodePaths = new Set(rootNodes.map(n => n.path));

                // Get virtual nodes for root level (from pending uploads)
                const virtualNodes = buildVirtualNodes(pendingUploads, '', realNodePaths);

                // Merge and sort: folders first, then files, alphabetically
                const allNodes = sortNodes([...virtualNodes, ...rootNodes]);

                return allNodes.map((node) => (
                  <TreeNode
                    key={node.path + (node.uploadStatus ? '-virtual' : '')}
                    node={node}
                    parentPath=""
                    level={0}
                    onFileOpen={onFileOpen}
                    expandedFolders={expandedFolders}
                    onToggleFolder={onToggleFolder}
                    selectedFilePath={selectedFilePath}
                    onRefresh={loadRoot}
                    onFileDeleted={onFileDeleted}
                    onFileRenamed={onFileRenamed}
                    onFileMoved={onFileMoved}
                    draggedItem={draggedItem}
                    setDraggedItem={setDraggedItem}
                    dropTarget={dropTarget}
                    setDropTarget={setDropTarget}
                    onExternalFileDrop={handleExternalFileDrop}
                    allPendingUploads={pendingUploads}
                    refreshTrigger={refreshTrigger}
                  />
                ));
              })()}
              {isCreatingFolder && (
                <div className="flex items-center gap-1 px-2 py-1" style={{ paddingLeft: '8px' }}>
                  <div className="w-4" />
                  <Folder className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <Input
                    ref={newFolderInputRef}
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onBlur={handleCreateFolder}
                    onKeyDown={handleNewFolderKeyDown}
                    placeholder="New folder name"
                    className="h-5 py-0 px-1 text-sm"
                  />
                </div>
              )}
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => setIsCreatingFolder(true)}>
          <FolderPlus className="w-4 h-4 mr-2" />
          New Folder
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
