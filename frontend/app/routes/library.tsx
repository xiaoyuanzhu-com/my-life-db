import { useState, useEffect, useCallback, useMemo, Suspense, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Upload, FolderUp, FolderPlus, LayoutGrid, List } from "lucide-react";
import { FileTree } from "~/components/library/file-tree";
import { FileGrid } from "~/components/library/file-grid";
import { FileViewer } from "~/components/library/file-viewer";
import { FileTabs } from "~/components/library/file-tabs";
import { FileFooterBar } from "~/components/library/file-footer-bar";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "~/components/ui/resizable";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { useAuth } from "~/contexts/auth-context";
import { useUploadNotifications } from "~/hooks/use-upload-notifications";

export interface TabState {
  path: string;
  name: string;
  content?: string;
  isDirty: boolean;
  isActive: boolean;
}

type ViewMode = 'tree' | 'grid';

function LibraryContent() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tabs, setTabs] = useState<TabState[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null);
  const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [activeFileMimeType, setActiveFileMimeType] = useState<string | null>(null);
  const [createFolderTrigger, setCreateFolderTrigger] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('tree');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Subscribe to upload notifications (shows toast on success/failure)
  useUploadNotifications();

  const activeTab = tabs.find((tab) => tab.isActive);
  const activeFilePath = activeTab?.path ?? null;
  const dirtyFiles = useMemo(() => new Set(tabs.filter((tab) => tab.isDirty).map((tab) => tab.path)), [tabs]);
  const openedFiles = tabs.map((tab) => ({ path: tab.path, name: tab.name }));

  const persistTabs = useCallback((nextTabs: TabState[]) => {
    try {
      localStorage.setItem("library:tabs", JSON.stringify(nextTabs));
    } catch (error) {
      console.error("Failed to save tabs to localStorage:", error);
    }
  }, []);

  const handleFileDataLoad = useCallback((contentType: string) => {
    setActiveFileMimeType(contentType);
  }, []);

  useEffect(() => {
    try {
      const savedTabs = localStorage.getItem("library:tabs");
      const savedExpandedFolders = localStorage.getItem("library:expandedFolders");
      const savedViewMode = localStorage.getItem("library:viewMode");

      if (savedTabs) {
        setTabs(JSON.parse(savedTabs));
      }
      if (savedExpandedFolders) {
        setExpandedFolders(new Set(JSON.parse(savedExpandedFolders)));
      }
      if (savedViewMode === 'tree' || savedViewMode === 'grid') {
        setViewMode(savedViewMode);
      }

      localStorage.removeItem("library:dirtyFiles");
      localStorage.removeItem("library:openedFiles");
      localStorage.removeItem("library:activeFile");
      localStorage.removeItem("library:fileEditStates");
    } catch (error) {
      console.error("Failed to load state from localStorage:", error);
    } finally {
      setIsInitialized(true);
    }
  }, []);

  useEffect(() => {
    if (!isInitialized) return;
    persistTabs(tabs);
  }, [tabs, isInitialized, persistTabs]);

  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem("library:expandedFolders", JSON.stringify(Array.from(expandedFolders)));
    } catch (error) {
      console.error("Failed to save expanded folders to localStorage:", error);
    }
  }, [expandedFolders, isInitialized]);

  // Persist view mode
  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem("library:viewMode", viewMode);
    } catch (error) {
      console.error("Failed to save view mode to localStorage:", error);
    }
  }, [viewMode, isInitialized]);

  useEffect(() => {
    const openParams = searchParams.getAll("open");
    if (openParams.length === 0) return;

    openParams.forEach((filePath) => {
      if (!filePath) return;
      const fileName = filePath.split("/").pop() || filePath;

      setTabs((prev) => {
        const existingTabIndex = prev.findIndex((t) => t.path === filePath);
        if (existingTabIndex !== -1) {
          return prev.map((t, i) => ({ ...t, isActive: i === existingTabIndex }));
        }
        return [...prev.map((t) => ({ ...t, isActive: false })), { path: filePath, name: fileName, isDirty: false, isActive: true }];
      });

      expandParentFolders(filePath);
    });

    navigate("/library", { replace: true });
  }, [searchParams, navigate]);

  const expandParentFolders = (filePath: string) => {
    const pathParts = filePath.split("/");

    setExpandedFolders((prev) => {
      const newExpandedFolders = new Set(prev);
      let currentPath = "";
      for (let i = 0; i < pathParts.length - 1; i++) {
        if (i === 0) {
          currentPath = "./" + pathParts[i];
        } else {
          currentPath += "/" + pathParts[i];
        }
        newExpandedFolders.add(currentPath);
      }
      return newExpandedFolders;
    });
  };

  const handleFileOpen = (path: string, name: string) => {
    setTabs((prev) => {
      const existingTabIndex = prev.findIndex((t) => t.path === path);
      if (existingTabIndex !== -1) {
        return prev.map((t, i) => ({ ...t, isActive: i === existingTabIndex }));
      }
      return [...prev.map((t) => ({ ...t, isActive: false })), { path, name, isDirty: false, isActive: true }];
    });
    expandParentFolders(path);
  };

  // Mobile: navigate to /file/<path> instead of opening in tabs
  const handleMobileFileOpen = useCallback((path: string, _name: string) => {
    navigate(`/file/${path}`);
  }, [navigate]);

  const closeFile = useCallback((path: string) => {
    setTabs((prev) => {
      const closingTabIndex = prev.findIndex((t) => t.path === path);
      if (closingTabIndex === -1) return prev;

      const next = prev.filter((t) => t.path !== path);
      const wasActive = prev[closingTabIndex].isActive;
      if (wasActive && next.length > 0) {
        next[next.length - 1].isActive = true;
      }
      return next;
    });
  }, []);

  const handleFileClose = useCallback(
    (path: string) => {
      if (dirtyFiles.has(path)) {
        setPendingClosePath(path);
        setIsCloseDialogOpen(true);
        return;
      }
      closeFile(path);
    },
    [closeFile, dirtyFiles]
  );

  const handleTabChange = (path: string) => {
    setTabs((prev) => prev.map((t) => ({ ...t, isActive: t.path === path })));
  };

  const handleToggleFolder = (path: string, isExpanded: boolean) => {
    const newExpandedFolders = new Set(expandedFolders);
    if (isExpanded) {
      newExpandedFolders.add(path);
    } else {
      newExpandedFolders.delete(path);
    }
    setExpandedFolders(newExpandedFolders);
  };

  const handleFileDeleted = useCallback((path: string) => {
    // Close tab if the deleted file was open
    setTabs((prev) => {
      const filtered = prev.filter((t) => t.path !== path && !t.path.startsWith(path + '/'));
      if (filtered.length > 0 && !filtered.some((t) => t.isActive)) {
        filtered[filtered.length - 1].isActive = true;
      }
      return filtered;
    });
  }, []);

  const handleFileRenamed = useCallback((oldPath: string, newPath: string) => {
    // Update tab if the renamed file was open
    setTabs((prev) =>
      prev.map((t) => {
        if (t.path === oldPath) {
          return { ...t, path: newPath, name: newPath.split('/').pop() || newPath };
        }
        // Handle files inside renamed folder
        if (t.path.startsWith(oldPath + '/')) {
          const newFilePath = newPath + t.path.slice(oldPath.length);
          return { ...t, path: newFilePath };
        }
        return t;
      })
    );
    // Update expanded folders
    setExpandedFolders((prev) => {
      const newSet = new Set<string>();
      prev.forEach((p) => {
        if (p === oldPath) {
          newSet.add(newPath);
        } else if (p.startsWith(oldPath + '/')) {
          newSet.add(newPath + p.slice(oldPath.length));
        } else {
          newSet.add(p);
        }
      });
      return newSet;
    });
  }, []);

  const handleFileMoved = useCallback((oldPath: string, newPath: string) => {
    // Same logic as rename for tabs
    handleFileRenamed(oldPath, newPath);
  }, [handleFileRenamed]);

  const handleContentChange = useCallback((filePath: string, content: string, isDirty: boolean) => {
    setTabs((prev) => prev.map((t) => (t.path === filePath ? { ...t, content, isDirty } : t)));
  }, []);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFolderUploadClick = () => {
    folderInputRef.current?.click();
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileArray = Array.from(files);

    try {
      const { getUploadQueueManager } = await import("~/lib/send-queue/upload-queue-manager");
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();

      // Batch enqueue all files at once (single notification)
      const batch = fileArray.map(file => ({ file, destination: "" }));
      await uploadManager.enqueueBatch(batch);
    } catch (error) {
      console.error("Failed to upload files:", error);
      toast.error(`Failed to upload files: ${error instanceof Error ? error.message : "Unknown error"}`);
    }

    // Reset input so the same file can be selected again
    e.target.value = "";
  };

  const handleFolderInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileArray = Array.from(files);

    try {
      const { getUploadQueueManager } = await import("~/lib/send-queue/upload-queue-manager");
      const uploadManager = getUploadQueueManager();
      await uploadManager.init();

      // Build batch with destinations from folder structure
      const batch = fileArray.map(file => {
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const pathParts = relativePath.split("/");
        pathParts.pop(); // Remove filename
        const destination = pathParts.join("/");
        return { file, destination };
      });

      // Batch enqueue all files at once (single notification)
      await uploadManager.enqueueBatch(batch);
    } catch (error) {
      console.error("Failed to upload folder:", error);
      toast.error(`Failed to upload folder: ${error instanceof Error ? error.message : "Unknown error"}`);
    }

    // Reset input so the same folder can be selected again
    e.target.value = "";
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "w" && activeFilePath) {
        e.preventDefault();
        handleFileClose(activeFilePath);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeFilePath, handleFileClose]);

  const confirmClose = useCallback(() => {
    if (pendingClosePath) {
      closeFile(pendingClosePath);
    }
    setIsCloseDialogOpen(false);
    setPendingClosePath(null);
  }, [closeFile, pendingClosePath]);

  const cancelClose = useCallback(() => {
    setIsCloseDialogOpen(false);
    setPendingClosePath(null);
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-hidden flex flex-col bg-background w-full">
      {/* Hidden file inputs (shared between mobile and desktop) */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFolderInputChange}
        {...{ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>}
      />

      {/* ============================================ */}
      {/* Mobile layout: full-screen grid view         */}
      {/* ============================================ */}
      <div className="md:hidden flex-1 overflow-hidden">
        <FileGrid
          onFileOpen={handleMobileFileOpen}
          selectedFilePath={null}
          onFileDeleted={handleFileDeleted}
          onFileRenamed={handleFileRenamed}
          onFileMoved={handleFileMoved}
          createFolderTrigger={createFolderTrigger}
          onUploadFile={handleUploadClick}
          onUploadFolder={handleFolderUploadClick}
        />
      </div>

      {/* ============================================ */}
      {/* Desktop layout: resizable panels             */}
      {/* ============================================ */}
      <div className="hidden md:flex flex-1 overflow-hidden min-h-0 w-full min-w-0">
        <div className="h-full min-h-0 min-w-0 flex flex-col w-full px-[10%]">
          <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0 min-w-0 w-full">
            <ResizablePanel defaultSize={25} minSize={15} className="border-r flex h-full flex-col overflow-hidden min-w-0">
              {/* Desktop toolbar with view toggle */}
              <div className="flex items-center gap-1 p-2 border-b">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleUploadClick}>
                  <Upload className="w-3.5 h-3.5" />
                  File
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleFolderUploadClick}>
                  <FolderUp className="w-3.5 h-3.5" />
                  Folder
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setCreateFolderTrigger((n) => n + 1)}>
                  <FolderPlus className="w-3.5 h-3.5" />
                  New Folder
                </Button>
                {/* View mode toggle */}
                <div className="ml-auto flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`h-7 w-7 p-0 ${viewMode === 'tree' ? 'bg-accent' : ''}`}
                    onClick={() => setViewMode('tree')}
                    title="Tree view"
                  >
                    <List className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`h-7 w-7 p-0 ${viewMode === 'grid' ? 'bg-accent' : ''}`}
                    onClick={() => setViewMode('grid')}
                    title="Grid view"
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>

              {/* Tree or Grid view based on viewMode */}
              <div className="flex-1 overflow-y-auto">
                {viewMode === 'tree' ? (
                  <FileTree
                    onFileOpen={handleFileOpen}
                    expandedFolders={expandedFolders}
                    onToggleFolder={handleToggleFolder}
                    selectedFilePath={activeFilePath}
                    onFileDeleted={handleFileDeleted}
                    onFileRenamed={handleFileRenamed}
                    onFileMoved={handleFileMoved}
                    createFolderTrigger={createFolderTrigger}
                  />
                ) : (
                  <FileGrid
                    onFileOpen={handleFileOpen}
                    selectedFilePath={activeFilePath}
                    onFileDeleted={handleFileDeleted}
                    onFileRenamed={handleFileRenamed}
                    onFileMoved={handleFileMoved}
                    createFolderTrigger={createFolderTrigger}
                  />
                )}
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={75} minSize={30} className="flex h-full flex-col overflow-hidden min-w-0">
              {openedFiles.length > 0 && (
                <div className="shrink-0 w-full min-w-0">
                  <FileTabs
                    files={openedFiles}
                    activeFile={activeFilePath}
                    dirtyFiles={dirtyFiles}
                    onTabChange={handleTabChange}
                    onTabClose={handleFileClose}
                  />
                </div>
              )}
              <div className="flex-1 min-h-0 min-w-0 w-full overflow-hidden">
                {openedFiles.length > 0 && activeFilePath ? (
                  <FileViewer
                    filePath={activeFilePath}
                    onFileDataLoad={handleFileDataLoad}
                    onContentChange={handleContentChange}
                    initialEditedContent={activeTab?.content}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                    Select a file to view
                  </div>
                )}
              </div>
              <FileFooterBar filePath={activeFilePath} mimeType={activeFileMimeType} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>

      <AlertDialog open={isCloseDialogOpen} onOpenChange={setIsCloseDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Closing this tab will discard them. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelClose}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmClose}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function LibraryPage() {
  const { isAuthenticated, isLoading } = useAuth();

  // Show loading state while checking authentication
  if (isLoading) {
    return null;
  }

  // Show welcome page when not authenticated
  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen p-8 text-center">
        <div>
          <h1 className="text-3xl font-bold mb-4">Library</h1>
          <p className="text-muted-foreground text-lg mb-8 max-w-2xl">
            Browse and manage your organized knowledge files and documents.
          </p>
          <p className="text-muted-foreground">
            Please sign in using the button in the header to get started.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen">Loading...</div>}>
      <LibraryContent />
    </Suspense>
  );
}
