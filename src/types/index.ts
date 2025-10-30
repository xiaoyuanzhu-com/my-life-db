// Core types for MyLifeDB

/**
 * Message Type - what kind of content the user sent
 */
export type MessageType =
  | 'text'      // Plain text only
  | 'url'       // Web link
  | 'image'     // Single image (no text)
  | 'audio'     // Audio recording
  | 'video'     // Video file
  | 'pdf'       // PDF document
  | 'mixed';    // Text + attachments

/**
 * Attachment Type - categorized file type
 */
export type AttachmentType = 'image' | 'audio' | 'video' | 'pdf' | 'other';

export interface EntryMetadata {
  id: string; // UUID v4
  type: MessageType; // Type of message
  slug: string | null; // URL-safe slug from AI-generated title, initially null
  title: string | null; // AI-generated title, initially null
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
  tags: string[]; // User or AI-generated tags

  // AI-enriched data (populated async during insights/review)
  ai: {
    enriched: boolean;
    enrichedAt: string | null; // ISO date string
    title: string | null; // AI-generated title suggestion
    tags: string[]; // AI-generated tags
    summary: string | null; // Brief AI summary
    confidence?: number; // 0-1 confidence score

    // Content analysis
    entities?: {
      people?: string[]; // People mentioned
      places?: string[]; // Locations mentioned
      organizations?: string[]; // Companies, groups
      concepts?: string[]; // Key concepts/topics
      dates?: string[]; // Dates/times mentioned
    };

    // Classification
    category?: 'journal' | 'idea' | 'observation' | 'question' | 'meeting' | 'todo' | 'note' | 'other';
    sentiment?: 'positive' | 'negative' | 'neutral' | 'mixed';
    priority?: 'low' | 'medium' | 'high' | 'urgent';

    // Context
    mood?: string; // For journal entries
    actionItems?: Array<{
      task: string;
      assignee?: string;
      dueDate?: string;
    }>;

    // Relationships
    relatedEntryIds?: string[]; // Similar/related entries
    suggestedSpaces?: string[]; // Suggested categories/spaces
  };

  // File attachments metadata
  attachments: Array<{
    filename: string;
    mimeType: string;
    size: number; // bytes
    type: AttachmentType; // Categorized file type
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

// AI Extraction Types
export interface TextExtractionResult {
  title: string | null;
  summary: string | null;
  tags: string[];
  entities: {
    people: string[];
    places: string[];
    organizations: string[];
    concepts: string[];
    dates: string[];
  };
  category: 'journal' | 'idea' | 'observation' | 'question' | 'meeting' | 'todo' | 'note' | 'other';
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  mood?: string;
  actionItems: Array<{
    task: string;
    assignee?: string;
    dueDate?: string;
  }>;
  confidence: number; // 0-1
}

export interface ImageExtractionResult {
  caption: string | null;
  ocrText: string | null;
  imageType: 'photo' | 'screenshot' | 'diagram' | 'chart' | 'document' | 'other';
  detectedObjects: string[];
  tags: string[];
  confidence: number;
}

export interface AudioExtractionResult {
  transcription: string | null;
  duration: number; // seconds
  speakerCount: number;
  keyPoints: string[];
  actionItems: Array<{
    task: string;
    assignee?: string;
  }>;
  sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
  confidence: number;
}

export interface LinkExtractionResult {
  title: string | null;
  description: string | null;
  previewImage: string | null;
  domain: string;
  contentType: 'article' | 'video' | 'product' | 'tool' | 'other';
  author?: string;
  publishedDate?: string;
  tags: string[];
  confidence: number;
}

export interface ExtractionOptions {
  includeEntities?: boolean;
  includeSentiment?: boolean;
  includeActionItems?: boolean;
  includeRelatedEntries?: boolean;
  minConfidence?: number; // 0-1, filter results below threshold
}

// ============================================================================
// New Inbox Database Types (file-based approach)
// ============================================================================

/**
 * File type categorization
 */
export type FileType = 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'other';

/**
 * Enrichment status for inbox items
 */
export type EnrichmentStatus = 'pending' | 'enriching' | 'enriched' | 'failed';

/**
 * Individual file in an inbox item
 * Includes both user uploads and generated files (e.g., content.html for URLs)
 */
export interface InboxFile {
  filename: string;
  size: number; // bytes
  mimeType: string;
  type: FileType;
  hash?: string; // Content hash for deduplication
  enrichment?: {
    // Image enrichment
    caption?: string;
    ocr?: string;
    faces?: Array<{
      name?: string;
      confidence: number;
      boundingBox?: { x: number; y: number; width: number; height: number };
    }>;

    // Audio/Video enrichment
    transcription?: string;
    duration?: number; // seconds

    // Document enrichment
    extractedText?: string;
    pageCount?: number;

    // URL enrichment (for content.html files)
    url?: string;
    title?: string;
    author?: string;
    publishedDate?: string;
  };
}

/**
 * Inbox item - temporary staging before moving to library
 * Stored in database (no metadata.json file)
 */
export interface InboxItem {
  // Core identity
  id: string; // UUID (permanent)
  folderName: string; // Current folder name (uuid initially, then slug)

  // Content type
  type: MessageType;

  // Files (text.md is just another file in this array)
  files: InboxFile[];

  // Enrichment state
  status: EnrichmentStatus;
  enrichedAt: string | null; // ISO date string
  error: string | null;

  // Item-level enrichment (not file-level)
  aiSlug: string | null; // Generated slug for folder rename

  // Schema version (for evolution tracking)
  schemaVersion: number;

  // Timestamps
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
}

// Enrichment summary included in API responses for inbox items
export interface InboxStageStatusSummary {
  taskType: string;
  status: 'to-do' | 'in-progress' | 'success' | 'failed';
  attempts: number;
  error: string | null;
  updatedAt: number | null;
}

export interface InboxEnrichmentSummary {
  inboxId: string;
  overall: EnrichmentStatus;
  stages: InboxStageStatusSummary[];
  hasFailures: boolean;
  completedCount: number;
  totalCount: number;
  crawlDone: boolean;
  summaryDone: boolean;
  screenshotReady: boolean;
  canRetry: boolean;
}

/**
 * Library file - permanent indexed file
 */
export interface LibraryFile {
  // Core identity
  id: string; // UUID (permanent)
  path: string; // Relative from MY_DATA_DIR

  // File attributes
  fileName: string;
  isFolder: boolean;
  fileSize: number | null; // NULL for folders
  modifiedAt: string; // ISO date string
  contentHash: string | null; // Only for text files

  // Content classification
  contentType: FileType | null;
  searchableText: string | null; // Extracted content for search

  // Enrichment (JSON, extensible)
  enrichment: {
    caption?: string;
    ocr?: string;
    summary?: string;
    tags?: string[];
    faces?: Array<{
      name?: string;
      confidence: number;
    }>;
    entities?: {
      people?: string[];
      places?: string[];
      organizations?: string[];
      concepts?: string[];
    };
    [key: string]: unknown; // Allow future enrichment fields
  } | null;

  // Schema version
  schemaVersion: number;

  // Timestamps
  indexedAt: string; // ISO date string
  enrichedAt: string | null; // ISO date string
}
