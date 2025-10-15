// Core types for MyLifeDB

export interface EntryMetadata {
  id: string;
  title?: string;
  tags?: string[];
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
  aiGenerated?: boolean;
}

export interface Entry {
  metadata: EntryMetadata;
  content: string;
  filePath: string; // Relative path from data root
}

export interface DirectoryMetadata {
  name: string;
  description?: string;
  createdAt: string;
  color?: string;
  icon?: string;
}

export interface Directory {
  path: string; // Relative path from data root
  metadata: DirectoryMetadata;
  entryCount: number;
  subdirectories: string[];
}

export interface SearchResult {
  type: 'entry' | 'directory';
  id: string;
  title: string;
  snippet: string;
  filePath: string;
  highlights?: string[];
  score: number;
}

export interface SearchQuery {
  query: string;
  filters?: {
    dateRange?: { start: string; end: string };
    directories?: string[];
    tags?: string[];
  };
  limit?: number;
}
