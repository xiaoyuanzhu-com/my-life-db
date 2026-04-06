import { useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Search, MoreVertical, Upload, FolderUp, FolderPlus, RefreshCw } from "lucide-react";
import { FileGrid } from "~/components/library/file-grid";
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

function DataContent() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [createFolderTrigger, setCreateFolderTrigger] = useState(0);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useUploadNotifications();

  const handleFileOpen = useCallback((path: string, _name: string) => {
    navigate(`/file/${path}`);
  }, [navigate]);

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

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      toast.info("Search coming soon");
    }
  }, [searchQuery]);

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
        <form onSubmit={handleSearch} className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </form>
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

      {/* File grid (same component for mobile and desktop) */}
      <div className="flex-1 overflow-hidden md:px-[10%]">
        <FileGrid
          key={refreshTrigger}
          onFileOpen={handleFileOpen}
          selectedFilePath={null}
          createFolderTrigger={createFolderTrigger}
          onUploadFile={handleUploadFile}
          onUploadFolder={handleUploadFolder}
        />
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

  return <DataContent />;
}
