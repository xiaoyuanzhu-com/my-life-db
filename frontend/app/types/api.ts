// Types for API endpoint responses
// Generated from backend/api/*.go and backend/db/models.go

// Types for /api/search endpoint responses
// Generated from backend/api/search.go

export interface MatchContext {
  source: string; // "keyword"
  snippet: string;
  terms: string[];
  label: string; // "File path" or "File content"
}

export interface SearchResultItem {
  path: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  mimeType: string | null;
  hash: string | null;
  modifiedAt: number;
  createdAt: number;
  score: number;
  snippet: string;
  textPreview?: string;
  previewSqlar?: string;
  highlights?: Record<string, string>;
  matchContext?: MatchContext;
  isPinned?: boolean;
}

export interface Timing {
  totalMs: number;
  searchMs: number;
  enrichMs: number;
}

export interface SearchResponse {
  results: SearchResultItem[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  query: string;
  timing: Timing;
  sources: string[];
}
