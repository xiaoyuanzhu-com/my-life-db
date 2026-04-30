import { useState, useRef, useEffect } from 'react';
import { FolderClosed, Pencil, Trash2, Copy, Loader2, CircleAlert, Download, Upload, FolderUp, FolderPlus, PackageOpen } from 'lucide-react';
import { cn } from '~/lib/utils';
import { api } from '~/lib/api';
import { downloadFile, downloadFolder, getSqlarUrl } from '~/components/FileCard/utils';
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
import { formatSmartTimestamp } from '~/lib/i18n/format';

const archiveExtensions = ['.zip', '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz', '.tar.zst', '.7z', '.rar'];

function isArchiveFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return archiveExtensions.some(ext => lower.endsWith(ext));
}

interface GridItemProps {
  node: FileNode;
  fullPath: string;
  isSelected?: boolean;
  /** Visual layout: 'grid' is the default tile layout; 'list' is a compact row */
  variant?: 'grid' | 'list';
  onClick: () => void;
  onRefresh: () => void;
  onFileDeleted?: (path: string) => void;
  onFileRenamed?: (oldPath: string, newPath: string) => void;
  /** Upload files to this folder (only for folder items) */
  onUploadFileTo?: (targetPath: string) => void;
  /** Upload folder to this folder (only for folder items) */
  onUploadFolderTo?: (targetPath: string) => void;
  /** Create a new subfolder in this folder (only for folder items) */
  onNewFolderIn?: (parentPath: string) => void;
}

export function GridItem({
  node,
  fullPath,
  isSelected,
  variant = 'grid',
  onClick,
  onRefresh,
  onFileDeleted,
  onFileRenamed,
  onUploadFileTo,
  onUploadFolderTo,
  onNewFolderIn,
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

  const [isExtracting, setIsExtracting] = useState(false);

  const handleExtract = async () => {
    setIsExtracting(true);
    try {
      const response = await api.post('/api/library/extract', { path: fullPath });
      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to extract archive');
        return;
      }
      onRefresh();
    } catch (error) {
      console.error('Failed to extract:', error);
      alert('Failed to extract archive');
    } finally {
      setIsExtracting(false);
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

  const isList = variant === 'list';

  // Shared icon block — sized differently per variant.
  const iconBlock = (
    <div
      className={cn(
        'relative flex items-center justify-center shrink-0',
        isList ? 'w-8 h-8' : 'w-12 h-12',
      )}
    >
      {isFolder ? (
        <FolderClosed className={cn(isList ? 'w-7 h-7' : 'w-10 h-10', 'text-muted-foreground')} />
      ) : node.previewSqlar ? (
        <img
          src={getSqlarUrl(node.previewSqlar)}
          alt=""
          loading="lazy"
          className={cn(isList ? 'w-8 h-8' : 'w-12 h-12', 'object-cover rounded')}
        />
      ) : (
        <FileTypeIcon filename={name} size={isList ? 24 : 36} />
      )}
      {isUploading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 rounded">
          <Loader2 className={cn(isList ? 'w-4 h-4' : 'w-5 h-5', 'animate-spin text-muted-foreground')} />
        </div>
      )}
      {!isList && node.uploadStatus === 'uploading' && node.uploadProgress !== undefined && (
        <span className="absolute -bottom-1 text-[10px] tabular-nums text-muted-foreground bg-background rounded px-0.5">
          {node.uploadProgress}%
        </span>
      )}
      {hasError && (
        <CircleAlert className={cn('absolute -top-1 -right-1 text-destructive', isList ? 'w-3.5 h-3.5' : 'w-4 h-4')} />
      )}
    </div>
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {isList ? (
            <button
              className={cn(
                'flex flex-row items-center gap-3 px-2 py-1.5 rounded-md transition-colors w-full text-left',
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
              {iconBlock}

              {/* Name (flex-1, truncates) */}
              {isRenaming ? (
                <Input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={handleRenameSubmit}
                  onKeyDown={handleRenameKeyDown}
                  onClick={(e) => e.stopPropagation()}
                  className="h-6 py-0 px-1 text-xs flex-1"
                />
              ) : (
                <span
                  className={cn(
                    'text-sm truncate flex-1 min-w-0',
                    hasError && !isFolder && 'text-destructive',
                  )}
                  title={name}
                >
                  {name}
                </span>
              )}

              {/* Metadata columns: hidden on small screens to keep rows scannable */}
              <span className="hidden sm:inline text-xs text-muted-foreground tabular-nums w-24 text-right shrink-0 truncate">
                {node.modifiedAt ? formatSmartTimestamp(node.modifiedAt) : ''}
              </span>
              <span className="hidden md:inline text-xs text-muted-foreground tabular-nums w-24 text-right shrink-0 truncate">
                {node.createdAt ? formatSmartTimestamp(node.createdAt) : ''}
              </span>
              <span className="hidden sm:inline text-xs text-muted-foreground tabular-nums w-16 text-right shrink-0">
                {!isFolder && node.size != null ? formatFileSize(node.size) : ''}
              </span>
            </button>
          ) : (
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
              {iconBlock}

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
                </div>
              )}
            </button>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          {isFolder && (
            <>
              <ContextMenuItem onClick={() => onUploadFileTo?.(fullPath)}>
                <Upload className="w-4 h-4 mr-2" />
                Upload Files Here
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onUploadFolderTo?.(fullPath)}>
                <FolderUp className="w-4 h-4 mr-2" />
                Upload Folder Here
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onNewFolderIn?.(fullPath)}>
                <FolderPlus className="w-4 h-4 mr-2" />
                New Folder Here
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem onClick={handleDownload}>
            <Download className="w-4 h-4 mr-2" />
            Download
          </ContextMenuItem>
          {!isFolder && isArchiveFile(name) && (
            <ContextMenuItem onClick={handleExtract} disabled={isExtracting}>
              <PackageOpen className="w-4 h-4 mr-2" />
              {isExtracting ? 'Extracting...' : 'Extract Here'}
            </ContextMenuItem>
          )}
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
