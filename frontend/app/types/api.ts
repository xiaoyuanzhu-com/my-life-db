// Types for API endpoint responses
// Generated from backend/api/*.go and backend/db/models.go

export interface Digest {
  id: string;
  filePath: string;
  type: string; // digester name - alias for 'digester' field
  digester: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' | 'todo';
  content: string | null;
  sqlarName: string | null;
  error: string | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface InboxItem {
  path: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  mimeType: string | null;
  hash: string | null;
  modifiedAt: number;
  createdAt: number;
  digests: Digest[];
  textPreview?: string;
  screenshotSqlar?: string;
  isPinned: boolean;
}

export interface InboxResponse {
  items: InboxItem[];
  cursors: {
    first: string | null;
    last: string | null;
  };
  hasMore: {
    older: boolean;
    newer: boolean;
  };
  targetIndex?: number;
}

// Types for /api/search endpoint responses
// Generated from backend/api/search.go

export interface RleMask {
  size: [number, number];
  counts: number[];
}

export interface MatchedObject {
  title: string;
  bbox: [number, number, number, number];
  rle: RleMask | null;
}

export interface DigestInfo {
  type: string;
  label: string;
}

export interface MatchContext {
  source: 'digest' | 'semantic';
  snippet: string;
  terms: string[];
  score?: number;
  sourceType?: string; // For semantic matches
  digest?: DigestInfo; // For keyword matches
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
  digests: Digest[];
  score: number;
  snippet: string;
  textPreview?: string;
  screenshotSqlar?: string;
  highlights?: Record<string, string>;
  matchContext?: MatchContext;
  matchedObject?: MatchedObject;
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
