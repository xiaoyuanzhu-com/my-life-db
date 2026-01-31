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
  pendingUploads?: PendingInboxItem[];
}

function PendingUploadItem({ item, level }: { item: PendingInboxItem; level: number }) {
  const paddingLeft = `${level * 16 + 8}px`;
  const IconComponent = getFileIcon(item.filename);

  return (
    <div
      className="flex items-center gap-1 px-2 py-1 text-sm text-muted-foreground opacity-60"
      style={{ paddingLeft }}
    >
      <div className="w-4 flex items-center justify-center">
        <Loader2 className="w-3 h-3 animate-spin" />
      </div>
      <IconComponent className="w-4 h-4 flex-shrink-0" />
      <span className="truncate flex-1">{item.filename}</span>
      {item.status === 'uploading' && item.uploadProgress !== undefined && (
        <span className="text-xs">{item.uploadProgress}%</span>
      )}
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
  pendingUploads = [],
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
              {pendingUploads.map((item) => (
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
                  pendingUploads={[]}
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

  // Group pending uploads by their destination folder
  const pendingByFolder = pendingUploads.reduce((acc, item) => {
    const folder = item.destination || '';
    if (!acc[folder]) acc[folder] = [];
    acc[folder].push(item);
    return acc;
  }, {} as Record<string, PendingInboxItem[]>);

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
              {(pendingByFolder[''] || []).map((item) => (
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
                  pendingUploads={pendingByFolder[node.path] || []}
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
