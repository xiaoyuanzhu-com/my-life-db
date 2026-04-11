import { useState, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { Search, MoreVertical, Upload, FolderUp, FolderPlus, RefreshCw } from "lucide-react";
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
        Searching...
      </div>
    );
  }

  if (error && nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-destructive">
        Search failed: {error}
      </div>
    );
  }

  if (results && nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
        No results found
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
  const { openModal } = useModalNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentPath = searchParams.get("path") || "";
  const [searchQuery, setSearchQuery] = useState("");
  const [createFolderTrigger, setCreateFolderTrigger] = useState(0);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

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
      const batch = Array.from(files).map(file => ({ file, destination: "" }));
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
        return { file, destination: pathParts.join("/") };
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

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
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

      {/* Top bar: search + actions */}
      <div className="shrink-0 px-4 py-3 flex items-center gap-2 md:px-[10%]">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <MoreVertical className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleUploadFile}>
              <Upload className="h-4 w-4 mr-2" />
              Upload File
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleUploadFolder}>
              <FolderUp className="h-4 w-4 mr-2" />
              Upload Folder
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setCreateFolderTrigger(n => n + 1)}>
              <FolderPlus className="h-4 w-4 mr-2" />
              New Folder
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRefreshTrigger(n => n + 1)}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Breadcrumbs */}
      {!searchQuery.trim() && currentPath && (
        <div className="shrink-0 px-4 md:px-[10%]">
          <BreadcrumbNav currentPath={currentPath} onNavigate={handleNavigate} />
        </div>
      )}

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
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return null;

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen p-8 text-center">
        <div>
          <h1 className="text-3xl font-bold mb-4">Data</h1>
          <p className="text-muted-foreground text-lg mb-8 max-w-2xl">
            Browse and manage your personal data files.
          </p>
          <p className="text-muted-foreground">
            Please sign in to get started.
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
