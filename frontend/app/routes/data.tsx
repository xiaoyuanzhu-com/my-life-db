import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Search, Upload, FolderUp, FolderPlus, RefreshCw, Plus, Import } from "lucide-react";
import { FileGrid } from "~/components/library/file-grid";
import { BreadcrumbNav } from "~/components/library/breadcrumb-nav";
import { useSearch } from "~/components/omni-input/modules/use-search";
import { GridItem } from "~/components/library/grid-item";
import type { FileNode } from "~/components/library/library-utils";
import { ModalNavigationProvider, useModalNavigation } from "~/contexts/modal-navigation-context";
import type { FileWithDigests } from "~/types/file-card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useAuth } from "~/contexts/auth-context";
import { useUploadNotifications } from "~/hooks/use-upload-notifications";
import { cn } from "~/lib/utils";

function fileNodeToFileWithDigests(node: FileNode): FileWithDigests {
  const name = node.path.split("/").pop() || node.path;
  return {
    path: node.path,
    name,
    isFolder: node.type === "folder",
    size: node.size ?? null,
    mimeType: null,
    hash: null,
    modifiedAt: node.modifiedAt ?? 0,
    createdAt: node.modifiedAt ?? 0,
    digests: [],
    previewSqlar: node.previewSqlar,
  };
}

function SearchResultsGrid({
  results,
  isSearching,
  error,
}: {
  results: import("~/types/api").SearchResponse | null;
  isSearching: boolean;
  error: string | null;
}) {
  const { t } = useTranslation('data');
  const { openModal } = useModalNavigation();

  const nodes: FileNode[] = useMemo(() => {
    if (!results?.results) return [];
    return results.results.map((r) => ({
      path: r.path,
      type: r.isFolder ? "folder" as const : "file" as const,
      size: r.size ?? undefined,
      modifiedAt: r.modifiedAt,
      previewSqlar: r.previewSqlar ?? undefined,
    }));
  }, [results]);

  if (isSearching && nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
        {t('search.searching', 'Searching...')}
      </div>
    );
  }

  if (error && nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-destructive">
        {t('search.failed', 'Search failed: {{error}}', { error })}
      </div>
    );
  }

  if (results && nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
        {t('search.noResults', 'No results found')}
      </div>
    );
  }

  if (nodes.length === 0) return null;

  return (
    <div className="h-full overflow-y-auto p-2">
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-1">
        {nodes.map((node) => (
          <GridItem
            key={node.path}
            node={node}
            fullPath={node.path}
            onClick={() => {
              if (node.type === "folder") return;
              openModal(fileNodeToFileWithDigests(node));
            }}
            onRefresh={() => {}}
          />
        ))}
      </div>
    </div>
  );
}

function DataContent() {
  const { t } = useTranslation('data');
  const { openModal } = useModalNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentPath = searchParams.get("path") || "";
  const [searchQuery, setSearchQuery] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [createFolderTrigger, setCreateFolderTrigger] = useState(0);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const navigate = useNavigate();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleNavigate = useCallback((path: string) => {
    if (path) {
      setSearchParams({ path });
    } else {
      setSearchParams({});
    }
  }, [setSearchParams]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const { results: searchResults, isSearching, search, clear: clearSearch } = useSearch();

  useUploadNotifications();

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);

    const items = e.dataTransfer.items;
    if (!items || items.length === 0) return;

    // Extract entries SYNCHRONOUSLY before any await — the DataTransfer object
    // is cleared once the event handler yields (any await), making items/files
    // inaccessible after that point.
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    // Fallback: snapshot files synchronously too
    const fallbackFiles: File[] = entries.length === 0
      ? Array.from(e.dataTransfer.files)
      : [];

    try {
      const { getUploadQueueManager } = await import("~/lib/send-queue/upload-queue-manager");
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();

      // Collect files, preserving folder structure via webkitGetAsEntry
      const batch: { file: File; destination: string }[] = [];

      const readEntry = (entry: FileSystemEntry, basePath: string): Promise<void> => {
        return new Promise((resolve) => {
          if (entry.isFile) {
            (entry as FileSystemFileEntry).file((file) => {
              batch.push({ file, destination: basePath });
              resolve();
            });
          } else if (entry.isDirectory) {
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name;
            const readAll = (allEntries: FileSystemEntry[] = []) => {
              reader.readEntries((entries) => {
                if (entries.length === 0) {
                  Promise.all(allEntries.map((e) => readEntry(e, dirPath))).then(() => resolve());
                } else {
                  readAll([...allEntries, ...entries]);
                }
              });
            };
            readAll();
          } else {
            resolve();
          }
        });
      };

      if (entries.length > 0) {
        await Promise.all(entries.map((entry) => readEntry(entry, currentPath)));
      } else {
        for (const file of fallbackFiles) {
          batch.push({ file, destination: currentPath });
        }
      }

      if (batch.length > 0) {
        await uploadManager.enqueueBatch(batch);
      }
    } catch (error) {
      console.error("Failed to upload dropped files:", error);
      toast.error(`Failed to upload files: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }, [currentPath]);

  const handleFileOpen = useCallback((path: string, _name: string) => {
    openModal(fileNodeToFileWithDigests({ path, type: "file" }));
  }, [openModal]);

  const handleUploadFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleUploadFolder = useCallback(() => {
    folderInputRef.current?.click();
  }, []);

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    try {
      const { getUploadQueueManager } = await import("~/lib/send-queue/upload-queue-manager");
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();
      const batch = Array.from(files).map(file => ({ file, destination: currentPath }));
      await uploadManager.enqueueBatch(batch);
    } catch (error) {
      console.error("Failed to upload files:", error);
      toast.error(`Failed to upload files: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    e.target.value = "";
  };

  const handleFolderInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    try {
      const { getUploadQueueManager } = await import("~/lib/send-queue/upload-queue-manager");
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();
      const batch = Array.from(files).map(file => {
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const pathParts = relativePath.split("/");
        pathParts.pop();
        const relativeDir = pathParts.join("/");
        const destination = currentPath
          ? relativeDir ? `${currentPath}/${relativeDir}` : currentPath
          : relativeDir;
        return { file, destination };
      });
      await uploadManager.enqueueBatch(batch);
    } catch (error) {
      console.error("Failed to upload folder:", error);
      toast.error(`Failed to upload folder: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    e.target.value = "";
  };

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (value.trim()) {
      search(value);
    } else {
      clearSearch();
    }
  }, [search, clearSearch]);

  const handleSearchToggle = useCallback(() => {
    setSearchExpanded(true);
  }, []);

  const handleSearchCollapse = useCallback(() => {
    setSearchQuery("");
    clearSearch();
    setSearchExpanded(false);
  }, [clearSearch]);

  useEffect(() => {
    if (searchExpanded) {
      searchInputRef.current?.focus();
    }
  }, [searchExpanded]);

  return (
    <div
      className="flex-1 flex flex-col min-h-0 overflow-hidden relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag-and-drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-12 w-12" />
            <p className="text-lg font-medium">{t('dropzone.prompt', 'Drop files to upload')}</p>
            {currentPath && (
              <p className="text-sm text-muted-foreground">{t('dropzone.destination', 'to {{path}}', { path: currentPath })}</p>
            )}
          </div>
        </div>
      )}

      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFolderInputChange}
        {...{ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>}
      />

      {/* Top bar: breadcrumb + search + actions (single line) */}
      <div className="shrink-0 px-4 py-3 flex items-center gap-2 md:px-[10%]">
        <div className="flex-1 min-w-0">
          <BreadcrumbNav currentPath={currentPath} onNavigate={handleNavigate} />
        </div>
        <div
          className={cn(
            "relative h-9 overflow-hidden transition-[width] duration-100 ease-out",
            searchExpanded ? "w-56 sm:w-[28rem] max-w-full" : "w-9"
          )}
        >
          {/* Search icon button — visible when collapsed */}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSearchToggle}
            aria-label="Search"
            tabIndex={searchExpanded ? -1 : 0}
            className={cn(
              "absolute inset-0 transition-opacity duration-100 ease-out",
              searchExpanded ? "opacity-0 pointer-events-none" : "opacity-100"
            )}
          >
            <Search className="h-5 w-5" />
          </Button>
          {/* Search input — visible when expanded */}
          <div
            className={cn(
              "absolute inset-0 transition-opacity duration-100 ease-out",
              searchExpanded ? "opacity-100" : "opacity-0 pointer-events-none"
            )}
          >
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder={t('search.placeholder', 'Search files...')}
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") handleSearchCollapse();
              }}
              onBlur={(e) => {
                const next = e.relatedTarget as Node | null;
                if (next && e.currentTarget.parentElement?.contains(next)) return;
                handleSearchCollapse();
              }}
              tabIndex={searchExpanded ? 0 : -1}
              className="pl-9 pr-9 focus-visible:ring-0 focus-visible:border-input"
            />
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Add">
              <Plus className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleUploadFile}>
              <Upload className="h-4 w-4 mr-2" />
              {t('actions.uploadFile', 'Upload File')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleUploadFolder}>
              <FolderUp className="h-4 w-4 mr-2" />
              {t('actions.uploadFolder', 'Upload Folder')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setCreateFolderTrigger(n => n + 1)}>
              <FolderPlus className="h-4 w-4 mr-2" />
              {t('actions.newFolder', 'New Folder')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate('/data/apps')}>
              <Import className="h-4 w-4 mr-2" />
              {t('actions.importFromApps', 'Import from apps')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setRefreshTrigger(n => n + 1)}
          aria-label="Refresh"
        >
          <RefreshCw className="h-5 w-5" />
        </Button>
      </div>

      {/* Search results or file grid */}
      <div className="flex-1 overflow-hidden md:px-[10%]">
        {searchQuery.trim() ? (
          <SearchResultsGrid
            results={searchResults.keywordResults}
            isSearching={searchResults.isKeywordSearching}
            error={searchResults.keywordError}
          />
        ) : (
          <FileGrid
            key={refreshTrigger}
            onFileOpen={handleFileOpen}
            selectedFilePath={null}
            createFolderTrigger={createFolderTrigger}
            onUploadFile={handleUploadFile}
            onUploadFolder={handleUploadFolder}
            currentPath={currentPath}
            onNavigate={handleNavigate}
          />
        )}
      </div>
    </div>
  );
}

export default function DataPage() {
  const { t } = useTranslation('data');
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return null;

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen p-8 text-center">
        <div>
          <h1 className="text-3xl font-bold mb-4">{t('page.title', 'Data')}</h1>
          <p className="text-muted-foreground text-lg mb-8 max-w-2xl">
            {t('page.description', 'Browse and manage your personal data files.')}
          </p>
          <p className="text-muted-foreground">
            {t('page.signInHint', 'Please sign in to get started.')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <ModalNavigationProvider files={[]}>
      <DataContent />
    </ModalNavigationProvider>
  );
}
