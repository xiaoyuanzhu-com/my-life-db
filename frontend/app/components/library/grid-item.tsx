import { useState, useRef, useEffect } from 'react';
import { FolderClosed, Pencil, Trash2, Copy, Loader2, CircleAlert, Download } from 'lucide-react';
import { cn } from '~/lib/utils';
import { api } from '~/lib/api';
import { downloadFile, downloadFolder } from '~/components/FileCard/utils';
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
import { type FileNode, getNodeName, formatFileSize } from './library-utils';
import { FileTypeIcon } from './file-type-icon';

interface GridItemProps {
  node: FileNode;
  fullPath: string;
  isSelected?: boolean;
  onClick: () => void;
  onRefresh: () => void;
  onFileDeleted?: (path: string) => void;
  onFileRenamed?: (oldPath: string, newPath: string) => void;
}

export function GridItem({
  node,
  fullPath,
  isSelected,
  onClick,
  onRefresh,
  onFileDeleted,
  onFileRenamed,
}: GridItemProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(getNodeName(node));
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const name = getNodeName(node);
  const isFolder = node.type === 'folder';

  const isUploading = node.uploadStatus === 'pending' || node.uploadStatus === 'uploading';
  const hasError = node.uploadStatus === 'error';

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const startRename = () => {
    setRenameValue(name);
    setIsRenaming(true);
  };

  const handleRenameSubmit = async () => {
    if (!renameValue.trim() || renameValue === name) {
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

  const handleDownload = () => {
    if (isFolder) {
      downloadFolder(fullPath, name);
    } else {
      downloadFile(fullPath, name);
    }
  };

  // Long press for mobile context menu
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

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            className={cn(
              'flex flex-col items-center gap-2 p-3 rounded-lg transition-colors w-full',
              'hover:bg-accent active:bg-accent/70',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isSelected && 'bg-accent ring-1 ring-primary',
              isUploading && 'opacity-60',
            )}
            onClick={(e) => {
              if (isRenaming) return;
              e.stopPropagation();
              onClick();
            }}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
          >
            {/* Icon area */}
            <div className="relative flex items-center justify-center w-12 h-12">
              {isFolder ? (
                <FolderClosed className="w-10 h-10 text-muted-foreground" />
              ) : (
                <FileTypeIcon filename={name} size={36} />
              )}
              {/* Upload indicators */}
              {isUploading && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60 rounded">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              )}
              {node.uploadStatus === 'uploading' && node.uploadProgress !== undefined && (
                <span className="absolute -bottom-1 text-[10px] tabular-nums text-muted-foreground bg-background rounded px-0.5">
                  {node.uploadProgress}%
                </span>
              )}
              {hasError && (
                <CircleAlert className="absolute -top-1 -right-1 w-4 h-4 text-destructive" />
              )}
            </div>

            {/* Name */}
            {isRenaming ? (
              <Input
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={handleRenameSubmit}
                onKeyDown={handleRenameKeyDown}
                onClick={(e) => e.stopPropagation()}
                className="h-6 py-0 px-1 text-xs text-center w-full"
              />
            ) : (
              <div className="w-full text-center min-w-0">
                <p
                  className={cn(
                    'text-xs truncate',
                    hasError && !isFolder && 'text-destructive',
                  )}
                  title={name}
                >
                  {name}
                </p>
                {node.size !== undefined && !isFolder && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {formatFileSize(node.size)}
                  </p>
                )}
              </div>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={handleDownload}>
            <Download className="w-4 h-4 mr-2" />
            Download
          </ContextMenuItem>
          <ContextMenuSeparator />
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
            <AlertDialogTitle>Delete {isFolder ? 'folder' : 'file'}?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{name}&rdquo;?
              {isFolder && ' This will delete all contents inside.'}
              {' '}This action cannot be undone.
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
    </>
  );
}
