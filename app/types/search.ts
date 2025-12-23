import type { FileWithDigests } from './file-card';

/** RLE mask format from SAM */
export interface RleMask {
  size: [number, number]; // [height, width]
  counts: number[];
}

/** Matched object from image-objects digest for highlighting */
export interface MatchedObject {
  title: string;
  bbox: [number, number, number, number]; // normalized [0,1] coordinates [x1, y1, x2, y2]
  rle: RleMask | null;
}

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
  /** Matched object from image-objects for highlighting in image */
  matchedObject?: MatchedObject;
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
