import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router";
import { FileTree } from "~/components/library/file-tree";
import { FileViewer } from "~/components/library/file-viewer";
import { FileTabs } from "~/components/library/file-tabs";
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

export interface OpenedFile {
  path: string;
  name: string;
}

interface FileEditState {
  content: string;
  isDirty: boolean;
}

export default function LibraryBrowsePage() {
  const [openedFiles, setOpenedFiles] = useState<OpenedFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [fileEditStates, setFileEditStates] = useState<Map<string, FileEditState>>(new Map());
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null);
  const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  const persistFileEditStates = useCallback((next: Map<string, FileEditState>) => {
    try {
      localStorage.setItem("library:fileEditStates", JSON.stringify(Array.from(next.entries())));
    } catch (error) {
      console.error("Failed to save file edit states to localStorage:", error);
    }
  }, []);

  const persistDirtyFiles = useCallback((next: Set<string>) => {
    try {
      localStorage.setItem("library:dirtyFiles", JSON.stringify(Array.from(next)));
    } catch (error) {
      console.error("Failed to save dirty files to localStorage:", error);
    }
  }, []);

  useEffect(() => {
    try {
      const savedOpenedFiles = localStorage.getItem("library:openedFiles");
      const savedActiveFile = localStorage.getItem("library:activeFile");
      const savedExpandedFolders = localStorage.getItem("library:expandedFolders");
      const savedFileEditStates = localStorage.getItem("library:fileEditStates");
      const savedDirtyFiles = localStorage.getItem("library:dirtyFiles");

      if (savedOpenedFiles) setOpenedFiles(JSON.parse(savedOpenedFiles));
      if (savedActiveFile) setActiveFilePath(savedActiveFile);
      if (savedExpandedFolders) setExpandedFolders(new Set(JSON.parse(savedExpandedFolders)));
      if (savedFileEditStates) {
        const statesArray: [string, FileEditState][] = JSON.parse(savedFileEditStates);
        setFileEditStates(new Map(statesArray));
      }
      if (savedDirtyFiles) setDirtyFiles(new Set(JSON.parse(savedDirtyFiles)));
    } catch (error) {
      console.error("Failed to load state from localStorage:", error);
    } finally {
      setIsInitialized(true);
    }
  }, []);

  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem("library:openedFiles", JSON.stringify(openedFiles));
    } catch (error) {
      console.error("Failed to save opened files to localStorage:", error);
    }
  }, [openedFiles, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;
    try {
      if (activeFilePath) localStorage.setItem("library:activeFile", activeFilePath);
    } catch (error) {
      console.error("Failed to save active file to localStorage:", error);
    }
  }, [activeFilePath, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem("library:expandedFolders", JSON.stringify(Array.from(expandedFolders)));
    } catch (error) {
      console.error("Failed to save expanded folders to localStorage:", error);
    }
  }, [expandedFolders, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem("library:fileEditStates", JSON.stringify(Array.from(fileEditStates.entries())));
    } catch (error) {
      console.error("Failed to save file edit states to localStorage:", error);
    }
  }, [fileEditStates, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem("library:dirtyFiles", JSON.stringify(Array.from(dirtyFiles)));
    } catch (error) {
      console.error("Failed to save dirty files to localStorage:", error);
    }
  }, [dirtyFiles, isInitialized]);

  const handleFileOpen = (path: string, name: string) => {
    if (!openedFiles.some((f) => f.path === path)) {
      setOpenedFiles([...openedFiles, { path, name }]);
    }
    setActiveFilePath(path);
  };

  const closeFile = useCallback(
    (path: string) => {
      setOpenedFiles((prev) => {
        const next = prev.filter((f) => f.path !== path);
        setActiveFilePath((prevActive) => (prevActive === path ? (next[next.length - 1]?.path ?? null) : prevActive));
        return next;
      });

      setFileEditStates((prev) => {
        const next = new Map(prev);
        next.delete(path);
        persistFileEditStates(next);
        return next;
      });

      setDirtyFiles((prev) => {
        const next = new Set(prev);
        next.delete(path);
        persistDirtyFiles(next);
        return next;
      });
    },
    [persistDirtyFiles, persistFileEditStates]
  );

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
    setActiveFilePath(path);
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

  const handleContentChange = useCallback(
    (filePath: string, content: string, isDirty: boolean) => {
      setFileEditStates((prev) => {
        const newMap = new Map(prev);
        newMap.set(filePath, { content, isDirty });
        persistFileEditStates(newMap);
        return newMap;
      });

      setDirtyFiles((prev) => {
        const newSet = new Set(prev);
        if (isDirty) {
          newSet.add(filePath);
        } else {
          newSet.delete(filePath);
        }
        persistDirtyFiles(newSet);
        return newSet;
      });
    },
    [persistDirtyFiles, persistFileEditStates]
  );

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
    if (pendingClosePath) closeFile(pendingClosePath);
    setIsCloseDialogOpen(false);
    setPendingClosePath(null);
  }, [closeFile, pendingClosePath]);

  const cancelClose = useCallback(() => {
    setIsCloseDialogOpen(false);
    setPendingClosePath(null);
  }, []);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-background">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-foreground">Library Browser</h1>
        </div>
        <Link to="/library">
          <Button variant="ghost" size="sm">
            ← Back to Library
          </Button>
        </Link>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-64 border-r overflow-y-auto">
          <FileTree onFileOpen={handleFileOpen} expandedFolders={expandedFolders} onToggleFolder={handleToggleFolder} />
        </div>

        <div className="flex-1 flex flex-col overflow-hidden">
          {openedFiles.length > 0 ? (
            <>
              <FileTabs
                files={openedFiles}
                activeFile={activeFilePath}
                dirtyFiles={dirtyFiles}
                onTabChange={handleTabChange}
                onTabClose={handleFileClose}
              />
              <div className="flex-1 overflow-hidden">
                {activeFilePath && (
                  <FileViewer
                    filePath={activeFilePath}
                    onContentChange={handleContentChange}
                    initialEditedContent={fileEditStates.get(activeFilePath)?.content}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Select a file from the tree to view
            </div>
          )}
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
