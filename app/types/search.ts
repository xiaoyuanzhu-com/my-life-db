import type { FileWithDigests } from './file-card';

export interface SearchResultItem extends FileWithDigests {
  // Search metadata
  score: number;
  snippet: string;
  highlights?: {
    content?: string;
    summary?: string;
    tags?: string;
  };
  matchContext?: {
    source: 'digest' | 'semantic';
    snippet: string;
    terms: string[];
    score?: number; // Similarity score for semantic matches (0.0-1.0)
    sourceType?: string; // Source type for semantic matches (content/summary/tags)
    digest?: {
      type: string;
      label: string;
    };
  };
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
  timing: {
    totalMs: number;
    searchMs: number;
    enrichMs: number;
  };
  sources: ('keyword' | 'semantic')[];
}
