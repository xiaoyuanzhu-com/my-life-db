import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, Folder, File, FileText, Image, Film, Music, FileCode, Pencil, Trash2, FolderPlus, Copy } from 'lucide-react';
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
  name: string;
  path: string;
  type: 'file' | 'folder';
  size?: number;
  modifiedAt?: string;
  children?: FileNode[];
}

interface FileTreeProps {
  onFileOpen: (path: string, name: string) => void;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string, isExpanded: boolean) => void;
  selectedFilePath?: string | null;
  onFileDeleted?: (path: string) => void;
  onFileRenamed?: (oldPath: string, newPath: string) => void;
  onFileMoved?: (oldPath: string, newPath: string) => void;
}

interface TreeNodeProps {
  node: FileNode;
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
}: TreeNodeProps) {
  const [children, setChildren] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isExpanded = expandedFolders.has(node.path);
  const isSelected = node.type === 'file' && node.path === selectedFilePath;
  const isDropTarget = dropTarget === node.path && node.type === 'folder';
  const isDragging = draggedItem?.path === node.path;

  const loadChildren = useCallback(async () => {
    if (isLoading) return;

    setIsLoading(true);
    try {
      const response = await fetch(`/api/library/tree?path=${encodeURIComponent(node.path)}`);
      const data = await response.json();
      setChildren(data.nodes || []);
    } catch (error) {
      console.error('Failed to load folder children:', error);
    } finally {
      setIsLoading(false);
    }
  }, [node.path]);

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
      onToggleFolder(node.path, !isExpanded);
    }
  };

  const handleClick = () => {
    if (isRenaming) return;
    if (node.type === 'file') {
      onFileOpen(node.path, node.name);
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
    setRenameValue(node.name);
    setIsRenaming(true);
  };

  const handleRenameSubmit = async () => {
    if (!renameValue.trim() || renameValue === node.name) {
      setIsRenaming(false);
      return;
    }

    try {
      const response = await fetch('/api/library/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: node.path, newName: renameValue.trim() }),
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to rename');
        return;
      }

      const result = await response.json();
      onFileRenamed?.(node.path, result.newPath);
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
      const response = await fetch(`/api/library/file?path=${encodeURIComponent(node.path)}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to delete');
        return;
      }

      onFileDeleted?.(node.path);
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
      await navigator.clipboard.writeText(node.path);
    } catch (error) {
      console.error('Failed to copy path:', error);
    }
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    setDraggedItem(node);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', node.path);
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
    setDropTarget(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (node.type === 'folder' && draggedItem && draggedItem.path !== node.path) {
      // Prevent dropping into self or children
      if (!draggedItem.path.startsWith(node.path + '/')) {
        e.dataTransfer.dropEffect = 'move';
        setDropTarget(node.path);
      }
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dropTarget === node.path) {
      setDropTarget(null);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);

    if (!draggedItem || node.type !== 'folder' || draggedItem.path === node.path) {
      return;
    }

    // Prevent dropping into self or children
    if (draggedItem.path.startsWith(node.path + '/')) {
      return;
    }

    try {
      const response = await fetch('/api/library/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: draggedItem.path, targetPath: node.path }),
      });

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

  const Icon = node.type === 'folder' ? Folder : getFileIcon(node.name);
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
              <span className="text-sm truncate" title={node.name}>
                {node.name}
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
              Are you sure you want to delete "{node.name}"?
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
            children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
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
              />
            ))
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
}: FileTreeProps) {
  const [rootNodes, setRootNodes] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const [draggedItem, setDraggedItem] = useState<FileNode | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const loadRoot = useCallback(async () => {
    try {
      const response = await fetch('/api/library/tree');
      const data = await response.json();
      setRootNodes(data.nodes || []);
    } catch (error) {
      console.error('Failed to load library tree:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRoot();
  }, [loadRoot]);

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
      const response = await fetch('/api/library/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '', name: newFolderName.trim() }),
      });

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
    if (draggedItem) {
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

    if (!draggedItem) return;

    // Don't move if already at root
    if (!draggedItem.path.includes('/')) {
      setDraggedItem(null);
      return;
    }

    try {
      const response = await fetch('/api/library/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: draggedItem.path, targetPath: '' }),
      });

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
          {rootNodes.length === 0 && !isCreatingFolder ? (
            <div className="p-4 text-sm text-muted-foreground">
              No files in library. Right-click to create a folder.
            </div>
          ) : (
            <>
              {rootNodes.map((node) => (
                <TreeNode
                  key={node.path}
                  node={node}
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
