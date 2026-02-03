import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, Folder, File, FileText, Image, Film, Music, FileCode, Pencil, Trash2, FolderPlus, Copy, Loader2 } from 'lucide-react';
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
}

function PendingUploadItem({ item, level }: { item: PendingInboxItem; level: number }) {
  const paddingLeft = `${level * 12 + 8}px`;
  const IconComponent = getFileIcon(item.filename);
  const progress = item.uploadProgress ?? 0;
  const isUploading = item.status === 'uploading';
  const hasError = !!item.errorMessage;

  return (
    <div
      className="relative flex items-center gap-1 px-2 py-1 text-sm text-muted-foreground"
      style={{ paddingLeft }}
    >
      {/* Progress bar background */}
      {isUploading && (
        <div
          className="absolute inset-0 bg-primary/10 transition-all duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      )}
      {/* Content */}
      <div className="relative flex items-center gap-1 w-full opacity-70">
        <div className="w-4 flex items-center justify-center flex-shrink-0">
          {hasError ? (
            <div className="w-2 h-2 rounded-full bg-destructive" title={item.errorMessage} />
          ) : (
            <Loader2 className="w-3 h-3 animate-spin text-primary" />
          )}
        </div>
        {/* File type indicator - just a small colored dot/line */}
        <div className="w-4 flex items-center justify-center flex-shrink-0">
          <IconComponent className="w-4 h-4" />
        </div>
        <span className="truncate flex-1" title={item.filename}>{item.filename}</span>
        {isUploading && (
          <span className="text-xs tabular-nums flex-shrink-0">{progress}%</span>
        )}
      </div>
    </div>
  );
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

  // Filter pending uploads for items that should appear directly in this folder
  // An item belongs here if its destination exactly matches this folder's full path
  const directPendingUploads = allPendingUploads.filter(
    (item) => item.destination === fullPath
  );

  const loadChildren = useCallback(async () => {
    if (isLoading) return;

    setIsLoading(true);
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
      loadChildren();
    }
  }, [isExpanded, node.type, children.length, loadChildren]);

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
            <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
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
              <span className="text-sm truncate" title={getNodeName(node)}>
                {getNodeName(node)}
              </span>
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
          {isLoading ? (
            <div className="text-xs text-muted-foreground px-2 py-1" style={{ paddingLeft: `${paddingLeft + 20}px` }}>
              Loading...
            </div>
          ) : (
            <>
              {/* Show pending uploads for this folder */}
              {directPendingUploads.map((item) => (
                <PendingUploadItem key={item.id} item={item} level={level + 1} />
              ))}
              {children.map((child) => (
                <TreeNode
                  key={child.path}
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
                />
              ))}
            </>
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

  // Subscribe to upload progress for showing pending uploads in tree
  useEffect(() => {
    let unsubscribeProgress: (() => void) | undefined;

    const setupUploadTracking = async () => {
      const { getUploadQueueManager } = await import('~/lib/send-queue/upload-queue-manager');
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();

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

  // Subscribe to SSE notifications for library changes
  // This handles ALL refresh cases: upload, delete, rename, move, create folder
  // from any source (this tab, other tabs, external changes)
  useLibraryNotifications({
    onLibraryChange: loadRoot,
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

      // Enqueue all files with their relative paths preserved
      for (const { file, relativePath } of allFiles) {
        // Extract the directory path from the relative path (e.g., "folder/subfolder/file.txt" -> "folder/subfolder")
        const pathParts = relativePath.split('/');
        pathParts.pop(); // Remove filename from path
        const relativeDir = pathParts.join('/');

        // Combine base destination with relative directory
        const destination = baseDestination
          ? relativeDir
            ? `${baseDestination}/${relativeDir}`
            : baseDestination
          : relativeDir;

        await uploadManager.enqueueFile(file, undefined, destination);
      }
      // Note: Tree refresh is handled by the persistent onUploadComplete subscription in useEffect
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

  // Pending uploads at root level (empty destination)
  const rootPendingUploads = pendingUploads.filter(
    (item) => item.destination === '' || item.destination === undefined
  );

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
              {/* Show pending uploads at root level */}
              {rootPendingUploads.map((item) => (
                <PendingUploadItem key={item.id} item={item} level={0} />
              ))}
              {rootNodes.map((node) => (
                <TreeNode
                  key={node.path}
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
                />
              ))}
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
