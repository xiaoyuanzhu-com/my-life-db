// Core types for MyLifeDB

export interface EntryMetadata {
  id: string; // UUID v4
  slug: string | null; // URL-safe slug from AI-generated title, initially null
  title: string | null; // AI-generated title, initially null
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
  tags: string[]; // User or AI-generated tags

  // AI-processed data (populated async during insights/review)
  ai: {
    processed: boolean;
    processedAt: string | null; // ISO date string
    title: string | null; // AI-generated title suggestion
    tags: string[]; // AI-generated tags
    summary: string | null; // Brief AI summary
    confidence?: number; // 0-1 confidence score
  };

  // File attachments metadata
  attachments: Array<{
    filename: string;
    mimeType: string;
    size: number; // bytes
    ai?: {
      caption?: string; // Image caption
      ocr?: string; // Extracted text
      transcription?: string; // Audio transcription
    };
  }>;
}

export interface Entry {
  metadata: EntryMetadata;
  content: string;
  directoryPath: string; // e.g., "inbox/2025-10-15/uuid-or-slug"
  date: string; // YYYY-MM-DD extracted from directory path
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
