import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, ChevronDown, Folder, File, FileText, Image, Film, Music, FileCode } from 'lucide-react';

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
}

interface TreeNodeProps {
  node: FileNode;
  level: number;
  onFileOpen: (path: string, name: string) => void;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string, isExpanded: boolean) => void;
  selectedFilePath?: string | null;
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

function TreeNode({ node, level, onFileOpen, expandedFolders, onToggleFolder, selectedFilePath }: TreeNodeProps) {
  const [children, setChildren] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const isExpanded = expandedFolders.has(node.path);
  const isSelected = node.type === 'file' && node.path === selectedFilePath;

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
  }, [isLoading, node.path]);

  useEffect(() => {
    // Load children when folder is expanded
    if (node.type === 'folder' && isExpanded && children.length === 0) {
      loadChildren();
    }
  }, [isExpanded, node.type, children.length, loadChildren]);

  const handleToggle = () => {
    if (node.type === 'folder') {
      onToggleFolder(node.path, !isExpanded);
    }
  };

  const handleClick = () => {
    if (node.type === 'file') {
      onFileOpen(node.path, node.name);
    } else {
      handleToggle();
    }
  };

  const Icon = node.type === 'folder' ? Folder : getFileIcon(node.name);
  const paddingLeft = level * 12 + 8;

  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-1 hover:bg-accent cursor-pointer group ${
          isSelected ? 'bg-accent' : ''
        }`}
        style={{ paddingLeft: `${paddingLeft}px` }}
        onClick={handleClick}
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
        <span className="text-sm truncate" title={node.name}>
          {node.name}
        </span>
      </div>

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
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function FileTree({ onFileOpen, expandedFolders, onToggleFolder, selectedFilePath }: FileTreeProps) {
  const [rootNodes, setRootNodes] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadRoot();
  }, []);

  const loadRoot = async () => {
    try {
      const response = await fetch('/api/library/tree');
      const data = await response.json();
      setRootNodes(data.nodes || []);
    } catch (error) {
      console.error('Failed to load library tree:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading library...
      </div>
    );
  }

  if (rootNodes.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No files in library
      </div>
    );
  }

  return (
    <div className="py-2">
      {rootNodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          level={0}
          onFileOpen={onFileOpen}
          expandedFolders={expandedFolders}
          onToggleFolder={onToggleFolder}
          selectedFilePath={selectedFilePath}
        />
      ))}
    </div>
  );
}
