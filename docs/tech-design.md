# Technical Design Document: MyLifeDB

**Version:** 1.1
**Last Updated:** 2025-10-28
**Status:** Updated - URL Crawl, File Indexing, Classification
**Owner:** Engineering Team

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Data Models](#4-data-models)
5. [Database Design](#5-database-design)
6. [API Specifications](#6-api-specifications)
7. [Component Architecture](#7-component-architecture)
8. [AI/ML Pipeline](#8-aiml-pipeline)
9. [Search Implementation](#9-search-implementation)
10. [Security & Authentication](#10-security--authentication)
11. [Performance Optimization](#11-performance-optimization)
12. [Deployment Architecture](#12-deployment-architecture)
13. [Testing Strategy](#13-testing-strategy)
14. [Development Guidelines](#14-development-guidelines)

---

## 1. Overview

### 1.1 Purpose

This document provides technical specifications for implementing MyLifeDB, a personal knowledge management system. It covers architecture decisions, data models, APIs, and implementation details.

### 1.2 Scope

- **In Scope:** System architecture, database design, API contracts, component structure, AI pipeline
- **Out of Scope:** Product requirements, user stories, business logic (see [product-design.md](./product-design.md))

### 1.3 Audience

- Backend Engineers
- Frontend Engineers
- DevOps Engineers
- ML/AI Engineers

### 1.4 Related Documents

- [Product Requirements Document](./product-design.md)
- [API Documentation](./api-docs.md) *(to be created)*
- [Database Migration Guide](./db-migrations.md) *(to be created)*

---

## 2. System Architecture

### 2.1 High-Level Architecture

```mermaid
graph TB
    subgraph Client["Client Layer<br/>(React 19 + Next.js 15)"]
        InboxUI[Inbox UI]
        ReflectionUI[Reflection UI]
        LibraryUI[Library UI]
        SearchUI[Search UI]
    end

    subgraph Application["Application Layer<br/>(Next.js API Routes)"]
        Capture[Capture Service]
        AI[AI Processor]
        Organization[Organization Service]
    end

    subgraph Data["Data Layer"]
        SQLite[(SQLite<br/>better-sqlite3)]
        Files[(File System<br/>Node FS API)]
        VectorDB[(Qdrant<br/>Vectors)]
    end

    subgraph SearchLayer["Search Layer<br/>(Docker Compose)"]
        Meilisearch[Meilisearch<br/>Keyword]
        QdrantSearch[Qdrant<br/>Semantic]
    end

    Client <-->|HTTP/WS| Application
    Application <--> Data
    Application <--> SearchLayer

    style Client fill:#e1f5ff
    style Application fill:#fff4e1
    style Data fill:#e8f5e9
    style SearchLayer fill:#f3e5f5
```

### 2.2 Architecture Principles

1. **Offline-First:** Core functionality works without internet
2. **Local-First:** Data stored locally, cloud optional
3. **Modular Design:** Loosely coupled services
4. **API-Driven:** Clear separation between frontend and backend
5. **Progressive Enhancement:** Basic features work, AI enhances

### 2.3 Data Flow

```mermaid
flowchart LR
    A[User Input] --> B[Client App]
    B --> C[API Route]
    C --> D[Service Layer]
    D --> E{Data Type}
    E -->|Metadata| F[SQLite]
    E -->|Content| G[File System]
    E -->|Vector| H[ChromaDB]
    D --> I[AI Pipeline]
    I --> J[Embeddings]
    J --> H
    I --> K[Tags/Clusters]
    K --> F
```

---

## 3. Technology Stack

### 3.1 Frontend

| Technology | Version | Purpose |
|------------|---------|---------|
| **Next.js** | 15.5+ | React framework with App Router |
| **React** | 19+ | UI library with concurrent features |
| **TypeScript** | 5.7+ | Type safety |
| **Tailwind CSS** | 4.0+ | Styling framework |
| **Zustand** | 5.0+ | Global state management |
| **React Query** | 5.0+ | Server state management |
| **Zod** | 3.23+ | Schema validation |
| **date-fns** | 3.0+ | Date utilities |

### 3.2 Backend

| Technology | Version | Purpose |
|------------|---------|---------|
| **Next.js API Routes** | 15.5+ | Backend API |
| **better-sqlite3** | 11.0+ | SQLite database driver |
| **Drizzle ORM** | 0.30+ | Type-safe database ORM |
| **NextAuth.js** | 5.0+ | Authentication |
| **sharp** | 0.33+ | Image processing |
| **ffmpeg** | - | Audio/video processing |

### 3.3 AI/ML & Search

| Technology | Version | Purpose |
|------------|---------|---------|
| **OpenAI SDK** | 4.0+ | AI API client (optional) |
| **Ollama** | Latest | Local LLM runtime (optional) |
| **Meilisearch** | 1.5+ | Instant keyword search engine |
| **Qdrant** | 1.7+ | Vector database for semantic search |
| **transformers.js** | 3.0+ | In-browser ML models |
| **natural** | 6.0+ | NLP utilities |

### 3.4 Development Tools

| Tool | Purpose |
|------|---------|
| **ESLint** | Linting |
| **Prettier** | Code formatting |
| **Vitest** | Unit testing |
| **Playwright** | E2E testing |
| **TSX** | TypeScript execution |

### 3.5 Technology Decision Log

| Decision | Rationale |
|----------|-----------|
| **Next.js over Remix/Astro** | Best React ecosystem, mature App Router, RSC support |
| **SQLite over PostgreSQL** | Offline-first, zero-config, portable, perfect for local-first apps |
| **Drizzle over Prisma** | Lighter, better TypeScript inference, SQL-like syntax |
| **Zustand over Redux** | Simpler API, less boilerplate, sufficient for our needs |
| **Meilisearch + Qdrant over single solution** | Best of both: instant keyword + semantic search |
| **Qdrant over ChromaDB** | More mature, better Docker support, richer features |
| **better-sqlite3 over node-sqlite3** | Synchronous API, better performance, simpler code |

**Search Stack Decision Log:**
- **Considered sqlite-vss:** Simpler (in-process), but less mature and fewer features
- **Considered FTS5 only:** Fast keyword search, but no semantic capabilities
- **Decision:** Accept Docker Compose complexity for superior search experience
- **Trade-off:** Operational complexity vs. feature completeness

---

## 4. Data Models

### 4.1 Core Entities (TypeScript Interfaces)

#### Entry (Inbox Item)

```typescript
interface Entry {
  id: string;                    // UUID v4
  userId: string;                // User identifier
  content: string;               // Main content (markdown)
  contentType: 'text' | 'voice' | 'file' | 'link';
  metadata: EntryMetadata;
  tags: string[];                // AI-generated tags
  suggestedSpaces: string[];     // Suggested Space IDs
  embedding: number[];           // 1536-dim vector (OpenAI) or 384-dim (local)
  createdAt: Date;
  updatedAt: Date;
  isArchived: boolean;
  spaceIds: string[];            // Linked Space IDs (many-to-many)
}

interface EntryMetadata {
  title?: string;                // Optional user-provided title
  source: 'manual' | 'integration' | 'voice';
  fileUrl?: string;              // Relative path to file
  fileName?: string;
  mimeType?: string;
  fileSize?: number;             // Bytes
  transcription?: string;        // For voice entries
  duration?: number;             // For audio/video (seconds)
  originalUrl?: string;          // For link captures
  linkPreview?: {
    title?: string;
    description?: string;
    image?: string;
  };
}
```

#### Space (Library Container)

```typescript
interface Space {
  id: string;                    // UUID v4
  userId: string;
  title: string;
  description: string;
  coverImage?: string;           // Relative path
  metadata: SpaceMetadata;
  entryIds: string[];            // Linked Entry IDs (computed from junction table)
  relatedSpaceIds: string[];     // Cross-references
  insights: Insight[];           // Embedded insights
  principles: Principle[];       // Embedded principles
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
  isArchived: boolean;
  source: 'ai_suggested' | 'manual' | 'merged';
}

interface SpaceMetadata {
  color?: string;                // Hex color
  icon?: string;                 // Emoji or icon name
  category?: string;             // User-defined category
  tags?: string[];               // User-defined tags
}
```

#### Cluster (AI Suggestion)

```typescript
interface Cluster {
  id: string;                    // UUID v4
  userId: string;
  entryIds: string[];
  suggestedTitle: string;
  confidence: number;            // 0-100
  keywords: string[];
  reasoning?: string;            // AI explanation (optional)
  createdAt: Date;
  status: 'pending' | 'accepted' | 'dismissed' | 'snoozed';
  snoozeUntil?: Date;
  resultingSpaceId?: string;     // If accepted
  dismissReason?: string;        // User feedback
}
```

#### Insight

```typescript
interface Insight {
  id: string;                    // UUID v4
  spaceId: string;
  content: string;               // AI-generated summary
  type: 'summary' | 'trend' | 'connection' | 'pattern';
  confidence: number;            // 0-100
  isPromoted: boolean;           // Promoted to Principle
  metadata?: {
    frequency?: Record<string, number>;  // Word frequencies
    timeRange?: { start: Date; end: Date };
    relatedEntryIds?: string[];
  };
  createdAt: Date;
}
```

#### Principle

```typescript
interface Principle {
  id: string;                    // UUID v4
  spaceId: string;
  content: string;               // User-confirmed truth
  sourceInsightId?: string;      // Origin insight
  sourceEntryIds: string[];      // Traceability
  notes?: string;                // User annotations
  createdAt: Date;
  updatedAt: Date;
}
```

### 4.2 Supporting Types

```typescript
// User Settings
interface UserSettings {
  userId: string;
  preferences: {
    theme: 'light' | 'dark' | 'auto';
    aiProvider: 'openai' | 'ollama' | 'none';
    defaultView: 'inbox' | 'library';
    weeklyDigest: boolean;
    digestDay: 0 | 1 | 2 | 3 | 4 | 5 | 6;  // 0 = Sunday
  };
  aiConfig?: {
    openaiApiKey?: string;
    ollamaModel?: string;
    embeddingModel?: string;
  };
  storageConfig?: {
    dataPath: string;
    backupPath?: string;
    autoBackup: boolean;
    maxFileSize: number;         // MB
  };
}

// Search Query
interface SearchQuery {
  query: string;
  filters?: {
    dateRange?: { start: Date; end: Date };
    contentTypes?: ('text' | 'voice' | 'file' | 'link')[];
    spaceIds?: string[];
    tags?: string[];
    minConfidence?: number;
    maxConfidence?: number;
  };
  sort?: 'relevance' | 'date' | 'title';
  limit?: number;
  offset?: number;
}

// Search Result
interface SearchResult {
  type: 'entry' | 'space';
  id: string;
  title: string;
  snippet: string;
  highlights: string[];          // Matched text fragments
  score: number;                 // Relevance score
  metadata: {
    createdAt: Date;
    tags?: string[];
    contentType?: string;
  };
}
```

---

## 5. Database Design

### 5.1 Schema (SQLite)

```sql
-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- Users
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,             -- NULL for OAuth users
  name TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settings JSON
);

CREATE INDEX idx_users_email ON users(email);

-- Schema versioning (for migration tracking)
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  description TEXT
);

INSERT INTO schema_version (version, description) VALUES (1, 'Initial schema with inbox and library tables');

-- Inbox (temporary staging, app-managed)
-- NOTE: Metadata stored in database only, NOT in .meta.json files
CREATE TABLE inbox (
  -- Core identity
  id TEXT PRIMARY KEY,                    -- UUID (permanent, even after folder rename)

  -- File system
  folder_name TEXT NOT NULL UNIQUE,       -- Current folder name (uuid initially, then slug after processing)

  -- Content type
  type TEXT NOT NULL CHECK(type IN ('text', 'url', 'image', 'audio', 'video', 'pdf', 'mixed')),

  -- Files (JSON array - all files treated equally, text.md is just another file)
  -- Schema: [{ filename, size, mimeType, type, hash, enrichment: {...} }]
  files JSON NOT NULL,

  -- Processing state
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
  processed_at DATETIME,
  error TEXT,

  -- Item-level enrichment (not file-level)
  ai_slug TEXT,                           -- Generated slug for folder rename

  -- Metadata versioning (for schema evolution detection)
  schema_version INTEGER DEFAULT 1,       -- Track which schema this record uses

  -- Timestamps
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE INDEX idx_inbox_created_at ON inbox(created_at DESC);
CREATE INDEX idx_inbox_status ON inbox(status);
CREATE INDEX idx_inbox_folder_name ON inbox(folder_name);
CREATE INDEX idx_inbox_schema_version ON inbox(schema_version);

-- NOTE: Full-text search moved to Meilisearch (external service)
-- NOTE: Vector search moved to Qdrant (external service)
-- SQLite FTS5 removed per architecture decision (see section 3.5)

-- Spaces (Library)
CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  cover_image TEXT,
  metadata JSON,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  is_archived INTEGER DEFAULT 0,
  source TEXT NOT NULL CHECK(source IN ('ai_suggested', 'manual', 'merged')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_spaces_user_created ON spaces(user_id, created_at DESC);
CREATE INDEX idx_spaces_user_accessed ON spaces(user_id, last_accessed_at DESC);
CREATE INDEX idx_spaces_user_archived ON spaces(user_id, is_archived);

-- Entry-Space relationships (many-to-many)
CREATE TABLE entry_spaces (
  entry_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT CHECK(added_by IN ('user', 'ai')),
  PRIMARY KEY (entry_id, space_id),
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_entry_spaces_space ON entry_spaces(space_id);

-- Space-Space relationships (cross-references)
CREATE TABLE space_relations (
  space_id_1 TEXT NOT NULL,
  space_id_2 TEXT NOT NULL,
  relation_type TEXT DEFAULT 'related',
  strength REAL DEFAULT 0.5,      -- 0-1
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space_id_1, space_id_2),
  FOREIGN KEY (space_id_1) REFERENCES spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (space_id_2) REFERENCES spaces(id) ON DELETE CASCADE,
  CHECK (space_id_1 < space_id_2) -- Prevent duplicates
);

-- Clusters (AI suggestions)
CREATE TABLE clusters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  entry_ids JSON NOT NULL,
  suggested_title TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 100),
  keywords JSON,
  reasoning TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'dismissed', 'snoozed')),
  snooze_until INTEGER,
  resulting_space_id TEXT,
  dismiss_reason TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (resulting_space_id) REFERENCES spaces(id) ON DELETE SET NULL
);

CREATE INDEX idx_clusters_user_status ON clusters(user_id, status);
CREATE INDEX idx_clusters_user_created ON clusters(user_id, created_at DESC);

-- Insights
CREATE TABLE insights (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('summary', 'trend', 'connection', 'pattern')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 100),
  is_promoted INTEGER DEFAULT 0,
  metadata JSON,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_insights_space ON insights(space_id, created_at DESC);
CREATE INDEX idx_insights_promoted ON insights(space_id, is_promoted);

-- Principles
CREATE TABLE principles (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source_insight_id TEXT,
  source_entry_ids JSON,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
  FOREIGN KEY (source_insight_id) REFERENCES insights(id) ON DELETE SET NULL
);

CREATE INDEX idx_principles_space ON principles(space_id, created_at DESC);

-- Activity Log (for analytics/debugging)
CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  metadata JSON,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_activity_user_created ON activity_log(user_id, created_at DESC);
```

### 5.2 Drizzle ORM Schema

```typescript
// lib/db/schema.ts
import { sqliteTable, text, integer, real, blob, index } from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  settings: text('settings', { mode: 'json' }).$type<UserSettings>(),
});

export const entries = sqliteTable('entries', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  contentType: text('content_type').notNull().$type<'text' | 'voice' | 'file' | 'link'>(),
  metadata: text('metadata', { mode: 'json' }).notNull().$type<EntryMetadata>(),
  tags: text('tags', { mode: 'json' }).$type<string[]>(),
  suggestedSpaces: text('suggested_spaces', { mode: 'json' }).$type<string[]>(),
  embedding: blob('embedding'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
}, (table) => ({
  userCreatedIdx: index('idx_entries_user_created').on(table.userId, table.createdAt),
  userArchivedIdx: index('idx_entries_user_archived').on(table.userId, table.isArchived),
}));

export const spaces = sqliteTable('spaces', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  coverImage: text('cover_image'),
  metadata: text('metadata', { mode: 'json' }).$type<SpaceMetadata>(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  lastAccessedAt: integer('last_accessed_at', { mode: 'timestamp' }).notNull(),
  isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
  source: text('source').notNull().$type<'ai_suggested' | 'manual' | 'merged'>(),
}, (table) => ({
  userCreatedIdx: index('idx_spaces_user_created').on(table.userId, table.createdAt),
  userAccessedIdx: index('idx_spaces_user_accessed').on(table.userId, table.lastAccessedAt),
}));

export const entrySpaces = sqliteTable('entry_spaces', {
  entryId: text('entry_id').notNull().references(() => entries.id, { onDelete: 'cascade' }),
  spaceId: text('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
  addedBy: text('added_by').$type<'user' | 'ai'>(),
}, (table) => ({
  pk: { columns: [table.entryId, table.spaceId] },
  spaceIdx: index('idx_entry_spaces_space').on(table.spaceId),
}));

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  entries: many(entries),
  spaces: many(spaces),
}));

export const entriesRelations = relations(entries, ({ one, many }) => ({
  user: one(users, {
    fields: [entries.userId],
    references: [users.id],
  }),
  spaces: many(entrySpaces),
}));

export const spacesRelations = relations(spaces, ({ one, many }) => ({
  user: one(users, {
    fields: [spaces.userId],
    references: [users.id],
  }),
  entries: many(entrySpaces),
  insights: many(insights),
  principles: many(principles),
}));
```

### 5.3 File Storage Structure (Updated)

**Decision:** Multi-app compatible structure with clear separation

```
MY_DATA_DIR/
├── .app/
│   └── mylifedb/
│       ├── database.sqlite          # All metadata (inbox + library index)
│       ├── inbox/                   # Temporary staging (app-managed)
│       │   ├── {uuid}/              # Initially UUID-named
│       │   │   ├── text.md          # User's raw text input (if any)
│       │   │   ├── photo.jpg        # User's uploaded file (if any)
│       │   │   └── song.mp3         # Another file (if any)
│       │   └── {slug}/              # After processing, renamed to slug
│       │       ├── text.md          # User's original text
│       │       ├── content.html     # For URLs: original HTML (preserved)
│       │       ├── screenshot.png   # For URLs: visual capture
│       │       └── main-content.md  # For URLs: cleaned extraction
│       ├── cache/
│       │   ├── thumbnails/
│       │   └── temp/
│       └── archive/                 # Archived content
│           └── {original-path}/
│
└── {user-library}/                  # User-owned, free-form (NO metadata.json!)
    ├── bookmarks/                   # User decides structure
    ├── dev/
    │   └── react/
    ├── notes/
    └── ...
```

**Key Design Decisions:**

1. **Inbox Location:** `.app/mylifedb/inbox/` (not root)
   - **Why:** Keeps app concepts separate from user content
   - **Alt:** Root directory - rejected (clutters user's namespace)

2. **Library Structure:** Root directory, completely free-form
   - **Why:** User owns structure, multi-app compatible
   - **Alt:** `library/` subfolder - rejected (unnecessary nesting)

3. **Metadata Storage:** Database only (no `.meta.json` files)
   - **Why:** Keeps user directories clean
   - **Alt:** Sidecar files - rejected (pollutes user structure)

### 5.4 Inbox Implementation Details

**Design Decisions:**

1. **File-based Approach (text.md = just another file)**
   - **Decision:** Treat text input as a file (text.md) rather than separate field
   - **Why:** Unified file handling, simpler enrichment pipeline, consistent processing
   - **Alt:** Text as separate DB field - rejected (special-case logic, harder to enrich)

2. **Database-only Metadata (no .meta.json files)**
   - **Decision:** All metadata stored in database, clean user directories
   - **Why:** No file pollution, faster queries, atomic updates
   - **Alt:** Sidecar .meta.json files - rejected (clutters directories, sync issues)

3. **UUID → Slug Workflow**
   - **Decision:** Folders initially named with UUID, renamed to slug after AI processing
   - **Why:** Stable ID (UUID never changes), human-readable names (slug), clean separation
   - **Alt:** Slug-only - rejected (slug collisions, can't identify before processing)

4. **File Deduplication Strategy (macOS-style)**
   - **Decision:** Space + number suffix pattern (`photo.jpg` → `photo 2.jpg`)
   - **Why:** Familiar to users, simple logic, preserves extensions
   - **Alt:** Hash suffixes - rejected (cryptic names), Timestamps - rejected (too long)

5. **Schema Versioning**
   - **Decision:** Track `schema_version` in both inbox and library tables
   - **Why:** Graceful evolution, detect outdated metadata, enable re-processing
   - **Implementation:** Version in DB column, schemas in metadata_schemas registry
   - **User Experience:** Badge shows outdated items, "Re-process" button upgrades

**Processing Features (Future Implementation):**

| Feature | Status | Implementation |
|---------|--------|----------------|
| **URL Crawling** | Planned | Playwright → content.html, screenshot.png, main-content.md |
| **Image Captioning** | Planned | Vision AI → enrichment.caption |
| **OCR Extraction** | Planned | Tesseract → enrichment.ocr |
| **Audio Transcription** | Planned | Whisper → enrichment.transcription |
| **PDF Parsing** | Planned | pdf-parse → enrichment.extractedText |

### 5.5 Task Queue Architecture

**Problem Statement:**

Traditional single `status` field is insufficient because:
- Multiple independent processes run on same item (search index, face detection, AI enrichment, etc.)
- Each external service can fail independently
- Need to retry failures without affecting other processes
- External services (Meilisearch, Qdrant, AI APIs) are unreliable

**Design Decision: Task-Based Processing**

Instead of boolean flags (`is_search_indexed`, `has_faces_detected`, etc.), use a general-purpose task queue to track all async/external operations.

**Architecture:**

```
┌─────────────────────┐
│  Application Logic  │
│  - Enqueue tasks    │
│  - Define handlers  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Task Queue (lib)   │
│  - Scheduling       │
│  - Retry logic      │
│  - Persistence      │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  SQLite (tasks)     │
│  - Pending          │
│  - Processing       │
│  - Completed/Failed │
└─────────────────────┘
```

**Task Queue Schema:**

```sql
CREATE TABLE tasks (
  -- Identity
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                     -- e.g., 'search_index', 'face_detection'

  -- Payload (application-defined JSON)
  payload TEXT NOT NULL,

  -- Status
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),

  -- Execution tracking
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  last_attempt_at TEXT,
  next_retry_at TEXT,                     -- Exponential backoff

  -- Results
  result TEXT,                            -- Success result (JSON)
  error TEXT,                             -- Failure error message

  -- Scheduling
  priority INTEGER DEFAULT 5              -- 1=highest, 10=lowest
    CHECK(priority >= 1 AND priority <= 10),
  run_after TEXT,                         -- Schedule for future

  -- Timestamps
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_tasks_pending ON tasks(status, priority, next_retry_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX idx_tasks_type ON tasks(type, status);
```

**Hybrid Approach: Cached Flags + Task Queue**

Combine fast queries (cached flags) with detailed tracking (task queue):

```sql
-- Inbox table: Add cached flags for UI performance
ALTER TABLE inbox ADD COLUMN is_search_indexed INTEGER DEFAULT 0;
ALTER TABLE inbox ADD COLUMN is_archived INTEGER DEFAULT 0;
ALTER TABLE inbox ADD COLUMN archived_at DATETIME;

-- Task queue: Track detailed execution state
-- (separate tasks table as shown above)
```

**Task Types:**

| Task Type | Priority | External Service | Retry Strategy |
|-----------|----------|------------------|----------------|
| `search_index` | High (3) | Meilisearch/Qdrant | 5 attempts, exp. backoff |
| `search_deindex` | High (1) | Meilisearch/Qdrant | 5 attempts, exp. backoff |
| `ai_slug_generation` | High (3) | LLM API | 3 attempts |
| `url_crawl` | High (3) | Playwright | 3 attempts |
| `image_caption` | Medium (5) | Vision API | 3 attempts |
| `face_detection` | Medium (5) | Face API | 3 attempts |
| `place_detection` | Medium (6) | Location API | 3 attempts |
| `audio_transcription` | Medium (5) | Whisper API | 3 attempts |
| `ai_summary` | Low (7) | LLM API | 3 attempts |

**Example Flow: Archive Item**

```typescript
async function archiveInboxItem(id: string) {
  const db = getDatabase();
  const queue = getTaskQueue();

  db.transaction(() => {
    // 1. Update database
    db.run(`UPDATE inbox SET is_archived = 1, archived_at = datetime('now') WHERE id = ?`, [id]);

    // 2. Move files
    const item = getInboxItemById(id);
    fs.renameSync(
      path.join(INBOX_DIR, item.folderName),
      path.join(ARCHIVE_DIR, item.folderName)
    );
    db.run(`UPDATE inbox SET folder_name = ? WHERE id = ?`, [`archive/${item.folderName}`, id]);

    // 3. Queue de-index task (async, can fail, will retry)
    if (item.isSearchIndexed) {
      queue.enqueue('search_deindex', { itemId: id }, {
        priority: 1,  // High priority
        maxAttempts: 5
      });
    }
  })();

  // Task worker processes de-index task asynchronously
}
```

**Retry Strategy:**

Exponential backoff with jitter:
```
Attempt 1: Fail → Retry in ~10s
Attempt 2: Fail → Retry in ~1min
Attempt 3: Fail → Retry in ~10min
Attempt 4: Fail → Retry in ~1hr
Attempt 5+: Fail → Retry in ~6hr (capped)
```

**Benefits:**

1. ✅ **Decoupled**: Archive succeeds even if de-index fails
2. ✅ **Resilient**: Auto-retry with backoff
3. ✅ **Observable**: Can query task status
4. ✅ **Maintainable**: Add new task types without schema changes
5. ✅ **Testable**: Disable worker for synchronous tests

**Trade-offs:**

| Aspect | Boolean Flags | Task Queue | Decision |
|--------|---------------|------------|----------|
| Query speed | ✅ Fast (indexed column) | ⚠️ Requires JOIN | Hybrid (cache + queue) |
| Retry logic | ❌ Manual | ✅ Built-in | Task queue |
| Error tracking | ❌ Lost | ✅ Preserved | Task queue |
| Complexity | ✅ Simple | ⚠️ More moving parts | Worth it |

**Implementation:**

See `src/lib/task-queue/` for application-agnostic task queue library.

### 5.6 File System Indexing

**Full directory/file index for semantic search across all content**

```sql
-- Library: Index all files (mylifedb-managed AND user-added)
-- Renamed from 'indexed_files' for clarity
CREATE TABLE library (
  -- Core identity
  id TEXT PRIMARY KEY,                    -- UUID (permanent, stable identifier)
  path TEXT NOT NULL UNIQUE,              -- Relative from MY_DATA_DIR (can change if user moves)

  -- File attributes
  file_name TEXT NOT NULL,
  is_folder BOOLEAN NOT NULL,
  file_size INTEGER,                      -- NULL for folders
  modified_at DATETIME NOT NULL,
  content_hash TEXT,                      -- Only for text files (performance)

  -- Content classification
  content_type TEXT,                      -- 'url' | 'text' | 'image' | 'pdf' | 'audio' | 'video'
  searchable_text TEXT,                   -- Extracted content for search engines

  -- Enrichment (JSON, extensible for schema evolution)
  -- Schema: { caption, ocr, summary, tags, faces, entities, etc. }
  enrichment JSON,

  -- Metadata versioning (for schema evolution detection)
  schema_version INTEGER DEFAULT 1,

  -- Timestamps
  indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  enriched_at DATETIME
);

CREATE INDEX idx_library_path_prefix ON library(path);
CREATE INDEX idx_library_modified ON library(modified_at);
CREATE INDEX idx_library_content_type ON library(content_type);
CREATE INDEX idx_library_schema_version ON library(schema_version);

-- Metadata schema registry (track expected schemas for validation)
CREATE TABLE metadata_schemas (
  version INTEGER PRIMARY KEY,
  table_name TEXT NOT NULL,               -- 'inbox' | 'library'
  field_name TEXT NOT NULL,               -- 'files' | 'enrichment'
  schema_json TEXT NOT NULL,              -- JSON Schema definition
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(table_name, field_name, version)
);

-- Example: Register initial schemas
INSERT INTO metadata_schemas (version, table_name, field_name, schema_json) VALUES
(1, 'inbox', 'files', '{
  "type": "array",
  "items": {
    "type": "object",
    "required": ["filename", "size", "mimeType", "type"],
    "properties": {
      "filename": {"type": "string"},
      "size": {"type": "integer"},
      "mimeType": {"type": "string"},
      "type": {"type": "string", "enum": ["text", "image", "audio", "video", "pdf", "other"]},
      "hash": {"type": "string"},
      "enrichment": {"type": "object"}
    }
  }
}'),
(1, 'library', 'enrichment', '{
  "type": "object",
  "properties": {
    "caption": {"type": "string"},
    "ocr": {"type": "string"},
    "summary": {"type": "string"},
    "tags": {"type": "array", "items": {"type": "string"}},
    "faces": {"type": "array"}
  }
}');
```

### 5.7 Schema Evolution Strategy

**Design Principle:** App should gracefully handle old data schemas and provide smooth upgrades

**Core Requirements:**
1. ✅ **Backward compatible:** App doesn't break when reading old schema data
2. ✅ **Detectable:** App highlights when metadata schema doesn't match current version
3. ✅ **Re-processable:** User can trigger re-processing to upgrade to latest schema
4. ✅ **Auto-migration:** Database table changes migrate automatically on app startup

**Implementation:**

```typescript
// 1. Schema Version Detection
export async function detectSchemaVersion(
  table: 'inbox' | 'library',
  record: any
): Promise<{
  currentVersion: number;
  expectedVersion: number;
  isOutdated: boolean;
  changes: string[];
}> {
  const currentVersion = record.schema_version || 1;
  const expectedVersion = await getLatestSchemaVersion(table);

  if (currentVersion === expectedVersion) {
    return { currentVersion, expectedVersion, isOutdated: false, changes: [] };
  }

  // Validate against expected schema
  const expectedSchema = await db.get(
    'SELECT schema_json FROM metadata_schemas WHERE table_name = ? AND version = ?',
    [table, expectedVersion]
  );

  const ajv = new Ajv();
  const validate = ajv.compile(JSON.parse(expectedSchema.schema_json));

  const fieldData = table === 'inbox' ? record.files : record.enrichment;
  const isValid = validate(fieldData);
  const changes = isValid ? [] : (validate.errors || []).map(e => e.message);

  return {
    currentVersion,
    expectedVersion,
    isOutdated: true,
    changes
  };
}

// 2. Re-process to Latest Schema
export async function migrateRecord(
  table: 'inbox' | 'library',
  id: string
): Promise<void> {
  const record = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);

  // Get raw files (always preserved)
  const rawFiles = JSON.parse(record.files || '[]');

  // Re-process with latest enrichment pipeline
  const enrichedFiles = await enrichFiles(rawFiles);

  // Update to latest schema
  const latestVersion = await getLatestSchemaVersion(table);
  await db.run(
    `UPDATE ${table}
     SET files = ?, schema_version = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(enrichedFiles), latestVersion, id]
  );
}

// 3. Automatic Database Migrations
export async function runMigrations() {
  const currentVersion = await db.get(
    'SELECT MAX(version) as version FROM schema_version'
  );

  const pendingMigrations = migrations.filter(
    m => m.version > (currentVersion?.version || 0)
  );

  for (const migration of pendingMigrations) {
    console.log(`Running migration ${migration.version}: ${migration.description}`);
    await migration.up(db);
    await db.run(
      'INSERT INTO schema_version (version, description) VALUES (?, ?)',
      [migration.version, migration.description]
    );
  }
}

// Example migration
export const migrations = [
  {
    version: 2,
    description: 'Add face recognition metadata to library enrichment',
    async up(db) {
      // Update metadata schema
      await db.run(`
        INSERT INTO metadata_schemas (version, table_name, field_name, schema_json)
        VALUES (2, 'library', 'enrichment', '{ ... new schema with faces ... }')
      `);

      // No need to update existing data - backward compatible
      // Users can re-process manually to get new enrichment
    }
  }
];
```

**UI Components:**

```typescript
// components/SchemaVersionBadge.tsx
export function SchemaVersionBadge({ record }: { record: InboxItem | LibraryFile }) {
  const { isOutdated, changes, currentVersion, expectedVersion } =
    await detectSchemaVersion(record.table, record);

  if (!isOutdated) return null;

  return (
    <div className="flex items-center gap-2">
      <Badge variant="warning">
        Schema v{currentVersion} (latest: v{expectedVersion})
      </Badge>
      <Button
        size="sm"
        onClick={() => migrateRecord(record.table, record.id)}
      >
        Re-process
      </Button>
      {changes.length > 0 && (
        <Tooltip content={`Missing: ${changes.join(', ')}`}>
          <InfoIcon />
        </Tooltip>
      )}
    </div>
  );
}
```

**Sync Strategy: Hybrid Approach**

```typescript
// 1. Real-time: fs.watch() for file system changes
const watcher = fs.watch(MY_DATA_DIR, { recursive: true });
watcher.on('change', async (eventType, filename) => {
  await indexFile(filename);  // Update index
});

// 2. Startup: Light reconciliation scan
async function reconcileIndex() {
  // Only check: which indexed files no longer exist?
  const indexed = await db.all('SELECT path, modified_at FROM library');

  for (const file of indexed) {
    const stats = await fs.stat(join(MY_DATA_DIR, file.path)).catch(() => null);
    if (!stats) {
      await db.run('DELETE FROM library WHERE path = ?', [file.path]);
    }
  }
}

// 3. Full scan: On-demand only (user triggers)
async function fullScan() {
  for await (const file of walkDirectory(MY_DATA_DIR)) {
    const existing = await db.get('SELECT modified_at FROM library WHERE path = ?', [file.path]);

    if (!existing || existing.modified_at < file.modifiedAt) {
      await indexFile(file);  // Changed or new
    }
  }
}
```

**Change Detection Strategy:**

| File Type | Detection Method | Reason |
|-----------|------------------|--------|
| **Text files** | `mtime + size + hash` | Content often changes without size change (edit word) |
| **Binary files** | `mtime + size` only | Hashing large files too expensive; size change = content changed |
| **Folders** | `mtime` only | Track folder itself, files handled separately |

**Performance Characteristics:**

| Operation | Speed | Notes |
|-----------|-------|-------|
| File system watch event | ~1ms | Real-time, incremental |
| Startup reconciliation (10k files) | ~200-500ms | Just checks existence |
| Full scan (10k files) | ~500ms-1s | Only checks timestamps |
| Text file hash | ~1-5ms | Fast, small files |
| Binary file hash | Skip | Too expensive (images: MB-GB) |

**Why Full Index (Not Minimal):**

- **Semantic search requirement:** Must search all content, not just app-managed
- **Multi-app scenario:** Discovers files added by other apps
- **Performance acceptable:** Modern SSDs handle 10k files in <1s
- **User expectation:** "Search everything" = everything in MY_DATA_DIR

**Alternatives Considered:**

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Minimal index (mylifedb-only)** | Simple, fast | Semantic search misses user content | ❌ Rejected |
| **On-demand scan (no index)** | Always in sync | Slow queries | ❌ Rejected |
| **Hash all files** | Perfect change detection | Too slow for binaries | ⚠️ Partial (text only) |
| **Cached folder sizes** | Fast folder stats | Complex invalidation | ❌ Rejected (on-demand fine) |
| **Hybrid (chosen)** | Best balance | Some complexity | ✅ Chosen |

### 5.8 URL Crawl Implementation

**End-to-End Flow:**

```typescript
// 1. User adds URL
async function addUrl(url: string, userId: string) {
  const entryId = uuid();
  const inboxPath = `.app/mylifedb/inbox/${entryId}`;

  // Create staging directory
  await fs.mkdir(join(MY_DATA_DIR, inboxPath), { recursive: true });
  await fs.writeFile(join(MY_DATA_DIR, inboxPath, 'url.txt'), url);

  // Save to database
  await db.run(`
    INSERT INTO entries (id, source_type, status, inbox_path)
    VALUES (?, 'url', 'pending', ?)
  `, [entryId, inboxPath]);

  // Queue for background processing
  await jobQueue.add('crawl-url', { entryId });

  return { entryId, inboxPath };
}

// 2. Background: Crawl & Process
async function crawlUrl(entryId: string) {
  const entry = await getEntry(entryId);
  const url = await fs.readFile(join(MY_DATA_DIR, entry.inbox_path, 'url.txt'), 'utf-8');

  try {
    // Crawl using Playwright/Puppeteer
    const { html, markdown, text, screenshot } = await crawlWebPage(url);

    // Extract metadata
    const metadata = extractMetadata(html);  // Title, author, date, etc.

    // Generate AI summary for folder name
    const aiSlug = await generateSlug(metadata.title || text.substring(0, 100));

    // Save to inbox
    const inboxPath = entry.inbox_path;
    await fs.writeFile(join(MY_DATA_DIR, inboxPath, 'content.html'), html);
    await fs.writeFile(join(MY_DATA_DIR, inboxPath, 'content.md'), markdown);
    await fs.writeFile(join(MY_DATA_DIR, inboxPath, 'main-content.md'), text);
    await fs.writeFile(join(MY_DATA_DIR, inboxPath, 'screenshot.png'), screenshot);

    // Rename folder to human-readable slug
    const newInboxPath = `.app/mylifedb/inbox/${aiSlug}`;
    await fs.rename(
      join(MY_DATA_DIR, inboxPath),
      join(MY_DATA_DIR, newInboxPath)
    );

    // Update database
    await db.run(`
      UPDATE entries
      SET status = 'ready', inbox_path = ?, metadata = ?
      WHERE id = ?
    `, [newInboxPath, JSON.stringify(metadata), entryId]);

  } catch (error) {
    await db.run(`UPDATE entries SET status = 'error', error = ? WHERE id = ?`, [error.message, entryId]);
  }
}

// 3. User Settlement: Manual Export
// User action: Copy .app/mylifedb/inbox/understanding-react-hooks/ to library root
// No code needed - pure file operation

// 4. Learning: Detect user's organization
async function learnFromUserMove(oldPath: string, newPath: string) {
  // Detect: user moved inbox/understanding-react-hooks → dev/react/understanding-react-hooks

  const entry = await db.get(`SELECT * FROM entries WHERE inbox_path LIKE ?`, `%${basename(oldPath)}%`);
  if (!entry) return;  // Not our entry

  const destination = dirname(newPath);  // "dev/react"

  // Extract signals
  const metadata = JSON.parse(entry.metadata || '{}');
  const url = metadata.url || '';
  const domain = url ? new URL(url).hostname : null;
  const keywords = extractKeywords(metadata.title || '');

  // Update learned patterns
  if (domain) {
    await db.run(`
      INSERT INTO learned_patterns (pattern_type, pattern_value, target_path, confidence, sample_count)
      VALUES ('domain', ?, ?, 0.5, 1)
      ON CONFLICT (pattern_type, pattern_value, target_path)
      DO UPDATE SET
        confidence = MIN(confidence + 0.2, 1.0),
        sample_count = sample_count + 1
    `, [domain, destination]);
  }

  for (const keyword of keywords.slice(0, 5)) {
    await db.run(`
      INSERT INTO learned_patterns (pattern_type, pattern_value, target_path, confidence, sample_count)
      VALUES ('keyword', ?, ?, 0.3, 1)
      ON CONFLICT (pattern_type, pattern_value, target_path)
      DO UPDATE SET confidence = MIN(confidence + 0.1, 1.0), sample_count = sample_count + 1
    `, [keyword, destination]);
  }

  // Mark entry as settled
  await db.run(`UPDATE entries SET status = 'settled', library_path = ? WHERE id = ?`, [newPath, entry.id]);
}
```

**Crawling Libraries:**

| Library | Purpose | Notes |
|---------|---------|-------|
| **Playwright** | Full browser automation | Best for JS-heavy sites, screenshots |
| **Cheerio** | HTML parsing | Fast for static sites |
| **Readability** | Article extraction | Mozilla's algorithm |
| **Turndown** | HTML → Markdown | Clean conversion |

---

## 6. API Specifications

### 6.1 REST API Endpoints

**Base URL:** `/api/v1`

#### Inbox

```typescript
// Create inbox item (multipart/form-data)
POST /api/inbox
Body: FormData {
  text?: string;           // Optional text content
  files?: File[];          // Optional file attachments
}
Response: InboxItem
Notes:
  - Must provide either text or files (or both)
  - Text saved as text.md file
  - Files saved with original names (auto-deduplicated if needed)
  - Returns full InboxItem with all metadata

// List inbox items
GET /api/inbox?status=pending&limit=50&offset=0
Response: {
  items: InboxItem[];
  total: number;
}

// Get inbox item by ID
GET /api/inbox/:id
Response: InboxItem

// Update inbox item
PUT /api/inbox/:id
Body: FormData {
  text?: string;           // Replace text content
  files?: File[];          // Add new files
  removeFiles?: string[];  // Filenames to remove
}
Response: InboxItem

// Delete inbox item (removes files too)
DELETE /api/inbox/:id
Response: { success: boolean }
```

#### Entries

```typescript
// Create entry
POST /api/v1/entries
Headers: { Authorization: Bearer {token} }
Body: {
  content: string;
  contentType: 'text' | 'voice' | 'file' | 'link';
  metadata?: Partial<EntryMetadata>;
}
Response: Entry

// Get entries (Inbox)
GET /api/v1/entries?limit=50&offset=0&filter=all&contentType=text&archived=false
Response: {
  entries: Entry[];
  total: number;
  hasMore: boolean;
}

// Get entry by ID
GET /api/v1/entries/:id
Response: Entry

// Update entry
PATCH /api/v1/entries/:id
Body: {
  content?: string;
  metadata?: Partial<EntryMetadata>;
  tags?: string[];
}
Response: Entry

// Delete entry
DELETE /api/v1/entries/:id
Response: { success: boolean }

// Link entry to space
POST /api/v1/entries/:id/spaces
Body: { spaceId: string }
Response: Entry

// Unlink entry from space
DELETE /api/v1/entries/:id/spaces/:spaceId
Response: { success: boolean }

// Trigger AI processing
POST /api/v1/entries/:id/process
Response: {
  tags: string[];
  suggestedSpaces: string[];
  embedding: number[];
}
```

#### Spaces

```typescript
// Create Space
POST /api/v1/spaces
Body: {
  title: string;
  description?: string;
  source: 'manual' | 'ai_suggested';
  entryIds?: string[];
  metadata?: Partial<SpaceMetadata>;
}
Response: Space

// Get all Spaces
GET /api/v1/spaces?archived=false
Response: Space[]

// Get Space by ID
GET /api/v1/spaces/:id?includeEntries=true
Response: Space & { entries?: Entry[] }

// Update Space
PATCH /api/v1/spaces/:id
Body: Partial<Space>
Response: Space

// Delete Space
DELETE /api/v1/spaces/:id?deleteEntries=false
Response: { success: boolean }

// Archive Space
POST /api/v1/spaces/:id/archive
Response: Space

// Export Space
GET /api/v1/spaces/:id/export?format=markdown
Response: File (application/zip)
```

#### Clusters

```typescript
// Get pending clusters
GET /api/v1/clusters?status=pending
Response: Cluster[]

// Accept cluster
POST /api/v1/clusters/:id/accept
Body: { title?: string; mergeWithSpaceId?: string }
Response: {
  cluster: Cluster;
  space: Space;
}

// Dismiss cluster
POST /api/v1/clusters/:id/dismiss
Body: { reason?: string }
Response: { success: boolean }

// Snooze cluster
POST /api/v1/clusters/:id/snooze
Body: { until: string } // ISO date
Response: Cluster

// Trigger clustering
POST /api/v1/clusters/generate
Body: { entryIds?: string[]; minConfidence?: number }
Response: Cluster[]
```

#### Search

```typescript
// Universal search
POST /api/v1/search
Body: SearchQuery
Response: {
  results: SearchResult[];
  total: number;
  queryTime: number; // ms
  facets?: {
    contentTypes: Record<string, number>;
    tags: Record<string, number>;
    spaces: Record<string, number>;
  };
}

// Semantic search (vector)
POST /api/v1/search/semantic
Body: {
  query: string;
  limit?: number;
  threshold?: number; // similarity threshold
}
Response: SearchResult[]
```

#### AI Processing

```typescript
// Generate tags
POST /api/v1/ai/tag
Body: { content: string; context?: string }
Response: { tags: string[] }

// Generate embedding
POST /api/v1/ai/embed
Body: { text: string }
Response: { embedding: number[] }

// Generate insights for Space
POST /api/v1/ai/insights/:spaceId
Response: Insight[]

// Classify destination (content organization)
POST /api/v1/ai/classify
Body: {
  content: string;
  contentType: 'url' | 'text' | 'image' | 'pdf';
  metadata?: { url?: string; title?: string };
}
Response: {
  path: string;              // Suggested destination
  confidence: number;        // 0-1
  reasoning: string;         // Why this location
  isNewFolder: boolean;      // Creating new vs. using existing
}

// Chat with content (future)
POST /api/v1/ai/chat
Body: {
  query: string;
  context?: { entryIds?: string[]; spaceIds?: string[] };
}
Response: {
  response: string;
  sources: Array<{ id: string; type: 'entry' | 'space' }>;
}
```

### 6.2 WebSocket Events

**Connection:** `ws://localhost:3000/api/ws`

```typescript
// Client → Server
{
  type: 'entry:subscribe',
  data: { userId: string }
}

{
  type: 'entry:create',
  data: { content: string, contentType: string }
}

// Server → Client
{
  type: 'entry:created',
  data: Entry
}

{
  type: 'entry:updated',
  data: Entry
}

{
  type: 'cluster:suggested',
  data: Cluster
}

{
  type: 'space:updated',
  data: Space
}

{
  type: 'ai:processing',
  data: { entryId: string, status: 'started' | 'completed' | 'failed' }
}
```

### 6.3 Error Responses

```typescript
interface APIError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// Common error codes
{
  'UNAUTHORIZED': 'Authentication required',
  'FORBIDDEN': 'Insufficient permissions',
  'NOT_FOUND': 'Resource not found',
  'VALIDATION_ERROR': 'Invalid input',
  'RATE_LIMIT': 'Too many requests',
  'INTERNAL_ERROR': 'Server error'
}
```

---

## 7. Component Architecture

### 7.1 Directory Structure

```
src/
├── app/                          # Next.js App Router
│   ├── (auth)/
│   │   ├── login/
│   │   │   └── page.tsx
│   │   └── signup/
│   │       └── page.tsx
│   ├── (dashboard)/
│   │   ├── inbox/
│   │   │   ├── page.tsx
│   │   │   └── components/
│   │   │       ├── EntryCard.tsx
│   │   │       ├── QuickAdd.tsx
│   │   │       └── SummaryPanel.tsx
│   │   ├── library/
│   │   │   ├── page.tsx
│   │   │   ├── [spaceId]/
│   │   │   │   └── page.tsx
│   │   │   └── components/
│   │   │       ├── SpaceCard.tsx
│   │   │       ├── SpaceDetail.tsx
│   │   │       └── SpaceSidebar.tsx
│   │   ├── reflection/
│   │   │   ├── page.tsx
│   │   │   └── components/
│   │   │       ├── ClusterList.tsx
│   │   │       ├── ClusterPreview.tsx
│   │   │       └── ClusterActions.tsx
│   │   └── search/
│   │       ├── page.tsx
│   │       └── components/
│   │           ├── SearchBar.tsx
│   │           ├── SearchResults.tsx
│   │           └── SearchFilters.tsx
│   ├── api/
│   │   └── v1/
│   │       ├── entries/
│   │       │   ├── route.ts
│   │       │   └── [id]/
│   │       │       └── route.ts
│   │       ├── spaces/
│   │       ├── clusters/
│   │       ├── search/
│   │       └── ai/
│   ├── layout.tsx
│   └── globals.css
├── components/                   # Shared components
│   ├── ui/                       # Base UI components
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Card.tsx
│   │   ├── Modal.tsx
│   │   └── ...
│   ├── layout/
│   │   ├── Header.tsx
│   │   ├── Sidebar.tsx
│   │   └── Container.tsx
│   └── shared/
│       ├── TagCloud.tsx
│       ├── DatePicker.tsx
│       └── FileUpload.tsx
├── lib/                          # Core business logic
│   ├── ai/
│   │   ├── tagger.ts
│   │   ├── clusterer.ts
│   │   ├── embeddings.ts
│   │   └── providers/
│   │       ├── openai.ts
│   │       └── ollama.ts
│   ├── db/
│   │   ├── client.ts
│   │   ├── schema.ts
│   │   ├── queries/
│   │   │   ├── entries.ts
│   │   │   ├── spaces.ts
│   │   │   └── clusters.ts
│   │   └── migrations/
│   │       ├── 001_initial.sql
│   │       └── ...
│   ├── storage/
│   │   ├── files.ts
│   │   └── backups.ts
│   ├── search/
│   │   ├── fulltext.ts
│   │   └── vector.ts
│   └── utils/
│       ├── validation.ts
│       ├── dates.ts
│       └── formatting.ts
├── hooks/                        # React hooks
│   ├── useEntries.ts
│   ├── useSpaces.ts
│   ├── useSearch.ts
│   └── useWebSocket.ts
├── stores/                       # Zustand stores
│   ├── authStore.ts
│   ├── uiStore.ts
│   └── syncStore.ts
├── types/                        # TypeScript types
│   ├── api.ts
│   ├── models.ts
│   └── index.ts
└── config/
    ├── constants.ts
    └── env.ts
```

### 7.2 Key Component Patterns

#### React Server Components (RSC)

```typescript
// app/(dashboard)/inbox/page.tsx
import { getEntries } from '@/lib/db/queries/entries';

export default async function InboxPage() {
  const entries = await getEntries({ limit: 50 });

  return (
    <div>
      <QuickAdd />
      <EntryList initialEntries={entries} />
    </div>
  );
}
```

#### Client Components with Server Actions

```typescript
// components/QuickAdd.tsx
'use client';

import { createEntry } from '@/app/actions/entries';

export function QuickAdd() {
  async function handleSubmit(formData: FormData) {
    const content = formData.get('content') as string;
    await createEntry({ content, contentType: 'text' });
  }

  return (
    <form action={handleSubmit}>
      <input name="content" />
      <button type="submit">Add</button>
    </form>
  );
}
```

---

## 8. AI/ML Pipeline

### 8.1 AI Architecture

```mermaid
graph TD
    Input[Content Input] --> Tagging[Tagging Service]
    Input --> Embedding[Embedding Service]

    Tagging --> Clustering[Clustering Engine]
    Embedding --> Clustering

    Clustering --> InsightGen[Insight Generator]

    InsightGen --> Classifier[Destination Classifier]

    Clustering -.-> ClusterDetails["• Similarity computation<br/>• DBSCAN/Hierarchical<br/>• Confidence scoring"]
    InsightGen -.-> InsightDetails["• Summarization<br/>• Trend detection<br/>• Connection finding"]
    Classifier -.-> ClassifierDetails["• Type detection (code)<br/>• Path suggestion (LLM)<br/>• Learning from actions"]

    style Tagging fill:#e3f2fd
    style Embedding fill:#e3f2fd
    style Clustering fill:#fff3e0
    style InsightGen fill:#f3e5f5
    style Classifier fill:#e8f5e9
    style ClusterDetails fill:#fff,stroke:#ccc,stroke-dasharray: 5 5
    style InsightDetails fill:#fff,stroke:#ccc,stroke-dasharray: 5 5
    style ClassifierDetails fill:#fff,stroke:#ccc,stroke-dasharray: 5 5
```

### 8.2 Content Type Detection vs Destination Classification

**Two-Stage Approach:**

#### Stage 1: Type Detection (Fast, Code-Based)

```typescript
// lib/ai/typeDetector.ts
export function detectContentType(item: InboxItem): ContentType {
  // Client-side capable, no AI needed
  if (item.url) {
    const ext = getFileExtension(item.url);
    if (['.jpg', '.png', '.gif', '.webp'].includes(ext)) return 'image';
    if (['.pdf'].includes(ext)) return 'pdf';
    if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
    if (['.mp3', '.wav', '.m4a'].includes(ext)) return 'audio';
    return 'url';  // Default for web pages
  }

  if (item.file) {
    const mime = item.file.mimeType;
    if (mime.startsWith('image/')) return 'image';
    if (mime === 'application/pdf') return 'pdf';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
  }

  return 'text';  // Default fallback
}
```

**Performance:** <1ms, 100% accurate for type

#### Stage 2: Destination Classification (LLM-Based, Evolving)

**Decision: Single Evolving Prompt Architecture**

```typescript
// lib/ai/destinationClassifier.ts
export class DestinationClassifier {
  async classify(item: ProcessedItem): Promise<ClassificationResult> {
    const guide = await this.buildGuide();

    const prompt = `${guide}

NEW ITEM TO CATEGORIZE:
Type: ${item.contentType}
${item.url ? `URL: ${item.url}\nDomain: ${new URL(item.url).hostname}` : ''}
Title: ${item.title}
Content preview: ${item.content?.substring(0, 1000)}

Suggest where to save this. Return JSON:
{
  "path": "exact/folder/path/",
  "confidence": 0.0-1.0,
  "reasoning": "one sentence explanation",
  "isNewFolder": boolean
}`;

    const result = await this.llm.complete(prompt, {
      temperature: 0.3,  // More deterministic
      responseFormat: 'json'
    });

    return JSON.parse(result);
  }

  private async buildGuide(): Promise<string> {
    // Scan user's library structure
    const folders = await this.scanLibraryFolders();

    // Get learned patterns
    const patterns = await db.all(`
      SELECT pattern_type, pattern_value, target_path, confidence, sample_count
      FROM learned_patterns
      WHERE confidence > 0.5
      ORDER BY confidence DESC, sample_count DESC
      LIMIT 50
    `);

    return `You are organizing content into a personal knowledge library.

CURRENT LIBRARY STRUCTURE:
${folders.map(f => `- ${f.path}/ (${f.count} items, last: ${f.lastModified})`).join('\n')}

LEARNED PATTERNS (from user's past choices):
${patterns.map(p =>
  `- ${p.pattern_type}:"${p.pattern_value}" → ${p.target_path} (conf: ${p.confidence.toFixed(2)}, seen ${p.sample_count}x)`
).join('\n')}

RULES:
- Prefer existing folders over creating new ones
- Consider content meaning, not just source type (a URL can be notes/todo/etc.)
- Use learned patterns as strong hints
- Be specific with paths (e.g., "dev/react/" not just "dev/")
- If truly doesn't fit, suggest new folder with clear reasoning`;
  }

  async learnFromUserAction(item: ProcessedItem, chosenPath: string) {
    const features = this.extractFeatures(item);

    // Update pattern confidences
    for (const [type, value] of Object.entries(features)) {
      await db.run(`
        INSERT INTO learned_patterns (pattern_type, pattern_value, target_path, confidence, sample_count)
        VALUES (?, ?, ?, 0.3, 1)
        ON CONFLICT (pattern_type, pattern_value, target_path)
        DO UPDATE SET
          confidence = MIN(confidence + 0.1, 1.0),
          sample_count = sample_count + 1,
          last_seen = CURRENT_TIMESTAMP
      `, [type, value, chosenPath]);
    }
  }

  private extractFeatures(item: ProcessedItem) {
    const features: Record<string, string> = {};

    if (item.url) {
      features.domain = new URL(item.url).hostname;
      features.urlPath = new URL(item.url).pathname.split('/')[1];
    }

    // Extract top keywords
    const keywords = extractKeywords(item.title + ' ' + item.content, { topN: 5 });
    keywords.forEach((kw, i) => {
      features[`keyword_${i}`] = kw;
    });

    return features;
  }
}
```

**Database Schema for Learning:**

```sql
CREATE TABLE learned_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_type TEXT NOT NULL,         -- 'domain', 'keyword', 'url_path'
  pattern_value TEXT NOT NULL,        -- 'github.com', 'react', '/blog/'
  target_path TEXT NOT NULL,          -- 'dev/', 'recipes/', 'notes/'

  confidence REAL DEFAULT 0.5,        -- 0-1, increases with correct usage
  sample_count INTEGER DEFAULT 1,     -- How many times seen
  last_seen DATETIME,                 -- Last time pattern matched

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(pattern_type, pattern_value, target_path)
);

CREATE INDEX idx_patterns_lookup ON learned_patterns(pattern_type, pattern_value, confidence DESC);
```

**Why This Approach:**

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| **Architecture** | Single LLM prompt (not pipeline) | Simplest, most flexible, fully transparent |
| **Type detection** | Separate, code-based | Fast, deterministic, no AI cost |
| **Learning** | Update prompt context | Transparent, user can see/edit rules |
| **Cache** | Cache identical URLs | Reduce LLM cost for duplicates |
| **Performance** | Accept ~1-2s LLM latency | Background job, user not blocked |

**Alternatives Considered:**

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Sequential pipeline (rules → LLM)** | Fast path for common cases | Complex code, harder to maintain | ❌ Rejected |
| **Decision tree** | Transparent logic | Rigid, hard to evolve | ❌ Rejected |
| **Ensemble (all vote)** | Uses all signals | Always pays LLM cost, complex | ❌ Rejected |
| **Pure rules (no LLM)** | Fast, cheap | Limited power for edge cases | ❌ Rejected |
| **Single prompt (chosen)** | Simple, flexible, transparent | Every call needs LLM | ✅ Chosen |

**Mitigation for LLM Cost:**

```typescript
// Cache classification results
const cacheKey = hash({
  url: item.url,
  title: item.title,
  contentPreview: item.content?.substring(0, 200)
});

const cached = await cache.get(`classify:${cacheKey}`);
if (cached) return cached;

const result = await classifier.classify(item);
await cache.set(`classify:${cacheKey}`, result, { ttl: '7d' });
```

### 8.3 Tagging Service

```typescript
// lib/ai/tagger.ts
import { OpenAI } from 'openai';
import { z } from 'zod';

const TagResponseSchema = z.object({
  tags: z.array(z.string()).min(2).max(5),
  reasoning: z.string().optional(),
});

export async function generateTags(
  content: string,
  context?: string
): Promise<string[]> {
  const provider = getAIProvider(); // OpenAI or Ollama

  const prompt = `
    Analyze the following content and generate 2-5 relevant tags.
    Tags should be concise, lowercase, and descriptive.

    Content: ${content}
    ${context ? `Context: ${context}` : ''}

    Return JSON: { "tags": ["tag1", "tag2", ...] }
  `;

  const response = await provider.complete(prompt);
  const parsed = TagResponseSchema.parse(JSON.parse(response));

  return parsed.tags;
}
```

### 8.3 Embedding Service

```typescript
// lib/ai/embeddings.ts
import { ChromaClient } from 'chromadb';

const chroma = new ChromaClient({ path: './data/vectors/chroma' });

export async function generateEmbedding(text: string): Promise<number[]> {
  const provider = getEmbeddingProvider();

  // OpenAI: text-embedding-3-small (1536-dim)
  // Local: all-MiniLM-L6-v2 (384-dim)
  const embedding = await provider.embed(text);

  return embedding;
}

export async function storeEmbedding(
  entryId: string,
  text: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const embedding = await generateEmbedding(text);
  const collection = await chroma.getOrCreateCollection({ name: 'entries' });

  await collection.add({
    ids: [entryId],
    embeddings: [embedding],
    metadatas: [metadata],
  });
}

export async function searchSimilar(
  query: string,
  limit: number = 10,
  threshold: number = 0.7
): Promise<Array<{ id: string; score: number }>> {
  const queryEmbedding = await generateEmbedding(query);
  const collection = await chroma.getCollection({ name: 'entries' });

  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: limit,
  });

  return results.ids[0].map((id, i) => ({
    id: id as string,
    score: results.distances[0][i],
  })).filter(r => r.score >= threshold);
}
```

### 8.4 Clustering Algorithm

```typescript
// lib/ai/clusterer.ts
import { cosineSimilarity, dbscan } from '@/lib/utils/ml';

export async function clusterEntries(
  entries: Entry[],
  minClusterSize: number = 3,
  minConfidence: number = 0.7
): Promise<Cluster[]> {
  // 1. Get embeddings for all entries
  const embeddings = entries.map(e => e.embedding);

  // 2. Compute pairwise similarities
  const similarities = computeSimilarityMatrix(embeddings);

  // 3. Run DBSCAN clustering
  const clusters = dbscan(similarities, {
    epsilon: 1 - minConfidence, // distance threshold
    minPoints: minClusterSize,
  });

  // 4. Generate cluster metadata
  const results: Cluster[] = [];
  for (const clusterIndices of clusters) {
    const clusterEntries = clusterIndices.map(i => entries[i]);

    // Extract common keywords
    const keywords = extractKeywords(clusterEntries);

    // Generate title suggestion
    const title = await generateClusterTitle(clusterEntries, keywords);

    // Compute confidence
    const confidence = computeClusterConfidence(clusterIndices, similarities);

    results.push({
      id: generateId(),
      userId: entries[0].userId,
      entryIds: clusterEntries.map(e => e.id),
      suggestedTitle: title,
      confidence: Math.round(confidence * 100),
      keywords,
      createdAt: new Date(),
      status: 'pending',
    });
  }

  return results.filter(c => c.confidence >= minConfidence * 100);
}

function computeSimilarityMatrix(embeddings: number[][]): number[][] {
  const n = embeddings.length;
  const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      matrix[i][j] = sim;
      matrix[j][i] = sim;
    }
  }

  return matrix;
}
```

### 8.5 Insight Generation

```typescript
// lib/ai/insights.ts
export async function generateInsights(space: Space): Promise<Insight[]> {
  const entries = await getEntriesForSpace(space.id);
  const insights: Insight[] = [];

  // 1. Summary insight
  const summary = await generateSummary(entries);
  insights.push({
    id: generateId(),
    spaceId: space.id,
    content: summary,
    type: 'summary',
    confidence: 85,
    isPromoted: false,
    createdAt: new Date(),
  });

  // 2. Trend analysis
  const trend = analyzeTrend(entries);
  if (trend) {
    insights.push({
      id: generateId(),
      spaceId: space.id,
      content: trend.description,
      type: 'trend',
      confidence: trend.confidence,
      isPromoted: false,
      metadata: { frequency: trend.frequency },
      createdAt: new Date(),
    });
  }

  // 3. Connection detection
  const connections = await findConnections(space.id);
  for (const conn of connections) {
    insights.push({
      id: generateId(),
      spaceId: space.id,
      content: `Related to ${conn.relatedSpace.title}`,
      type: 'connection',
      confidence: conn.strength * 100,
      isPromoted: false,
      createdAt: new Date(),
    });
  }

  return insights;
}
```

---

## 9. Search Implementation

### 9.1 Hybrid Search Strategy

```typescript
// lib/search/index.ts
export async function hybridSearch(
  query: SearchQuery
): Promise<SearchResult[]> {
  // 1. Full-text search (SQLite FTS5)
  const textResults = await fullTextSearch(query);

  // 2. Vector search (ChromaDB)
  const vectorResults = await vectorSearch(query);

  // 3. Merge and re-rank
  const merged = mergeResults(textResults, vectorResults);

  // 4. Apply filters
  const filtered = applyFilters(merged, query.filters);

  // 5. Sort
  const sorted = sortResults(filtered, query.sort || 'relevance');

  // 6. Paginate
  const paginated = sorted.slice(
    query.offset || 0,
    (query.offset || 0) + (query.limit || 20)
  );

  return paginated;
}

function mergeResults(
  textResults: SearchResult[],
  vectorResults: SearchResult[]
): SearchResult[] {
  const scoreMap = new Map<string, number>();

  // Combine scores with weights
  const TEXT_WEIGHT = 0.4;
  const VECTOR_WEIGHT = 0.6;

  for (const result of textResults) {
    scoreMap.set(result.id, result.score * TEXT_WEIGHT);
  }

  for (const result of vectorResults) {
    const current = scoreMap.get(result.id) || 0;
    scoreMap.set(result.id, current + result.score * VECTOR_WEIGHT);
  }

  // Get all unique results
  const allResults = [
    ...new Map([...textResults, ...vectorResults].map(r => [r.id, r])).values()
  ];

  // Update scores
  return allResults.map(r => ({
    ...r,
    score: scoreMap.get(r.id) || 0,
  }));
}
```

### 9.2 Full-Text Search

```typescript
// lib/search/fulltext.ts
import { db } from '@/lib/db/client';

export async function fullTextSearch(
  query: SearchQuery
): Promise<SearchResult[]> {
  const sql = `
    SELECT
      e.id,
      e.content,
      e.metadata,
      e.created_at,
      e.tags,
      bm25(entries_fts) as score,
      highlight(entries_fts, 0, '<mark>', '</mark>') as highlighted
    FROM entries_fts
    JOIN entries e ON entries_fts.rowid = e.rowid
    WHERE entries_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `;

  const results = await db.prepare(sql).all(query.query, query.limit || 20);

  return results.map(row => ({
    type: 'entry',
    id: row.id,
    title: extractTitle(row.content),
    snippet: extractSnippet(row.content, 200),
    highlights: extractHighlights(row.highlighted),
    score: row.score,
    metadata: {
      createdAt: new Date(row.created_at * 1000),
      tags: JSON.parse(row.tags || '[]'),
    },
  }));
}
```

---

## 10. Security & Authentication

### 10.1 Authentication Flow

```typescript
// lib/auth/config.ts
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import { compare } from 'bcryptjs';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: async (credentials) => {
        const user = await getUserByEmail(credentials.email);
        if (!user) return null;

        const isValid = await compare(credentials.password, user.passwordHash);
        if (!isValid) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.id as string;
      return session;
    },
  },
  pages: {
    signIn: '/login',
    signOut: '/logout',
  },
});
```

### 10.2 Authorization Middleware

```typescript
// middleware.ts
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/config';

export async function middleware(request: Request) {
  const session = await auth();

  // Protect API routes
  if (request.url.startsWith('/api/v1')) {
    if (!session) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        { status: 401 }
      );
    }
  }

  // Protect dashboard routes
  if (request.url.match(/^\/(inbox|library|reflection)/)) {
    if (!session) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/v1/:path*', '/(inbox|library|reflection)/:path*'],
};
```

### 10.3 Data Encryption

```typescript
// lib/storage/encryption.ts
import Database from 'better-sqlite3';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

export function initEncryptedDB(path: string, key: string): Database.Database {
  const db = new Database(path);

  // Enable SQLCipher encryption (requires special build)
  db.pragma(`key = '${key}'`);
  db.pragma('cipher_page_size = 4096');

  return db;
}

export function encryptField(data: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString('hex'),
    data: encrypted,
    tag: authTag.toString('hex'),
  });
}

export function decryptField(encrypted: string, key: Buffer): string {
  const { iv, data, tag } = JSON.parse(encrypted);

  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tag, 'hex'));

  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
```

---

## 11. Performance Optimization

### 11.1 Caching Strategy

```typescript
// lib/cache/index.ts
import { LRUCache } from 'lru-cache';

// In-memory cache for frequently accessed data
const cache = new LRUCache<string, unknown>({
  max: 500,
  ttl: 1000 * 60 * 5, // 5 minutes
});

export async function getCached<T>(
  key: string,
  fetcher: () => Promise<T>
): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached as T;

  const data = await fetcher();
  cache.set(key, data);

  return data;
}

// React Query configuration
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      cacheTime: 1000 * 60 * 30, // 30 minutes
      refetchOnWindowFocus: false,
    },
  },
});
```

### 11.2 Database Optimization

```sql
-- Vacuum regularly to optimize database
VACUUM;

-- Analyze query plans
ANALYZE;

-- Use prepared statements
PRAGMA query_only = OFF;

-- Enable WAL mode for better concurrency
PRAGMA journal_mode = WAL;

-- Optimize page cache
PRAGMA cache_size = -64000; -- 64MB

-- Auto-vacuum
PRAGMA auto_vacuum = INCREMENTAL;
```

### 11.3 Lazy Loading & Code Splitting

```typescript
// Dynamic imports for heavy components
const ReflectionView = dynamic(() => import('@/components/ReflectionView'), {
  loading: () => <Skeleton />,
  ssr: false,
});

// Route-based code splitting (automatic with Next.js App Router)
// Each route in app/ is automatically code-split
```

---

## 12. Deployment Architecture

### 12.1 Self-Hosted Deployment

```dockerfile
# Dockerfile
FROM node:20-alpine AS base

# Install dependencies
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Build application
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

CMD ["node", "server.js"]
```

```yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - NODE_ENV=production
      - DATABASE_URL=file:/app/data/db/mylifedb.sqlite
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
      - NEXTAUTH_URL=${NEXTAUTH_URL}
    restart: unless-stopped
```

### 12.2 Environment Configuration

```bash
# .env.example
# App
NODE_ENV=production
PORT=3000

# Database
DATABASE_URL=file:./data/db/mylifedb.sqlite

# Authentication
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=your-secret-key-here
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# AI Providers (optional)
OPENAI_API_KEY=
OLLAMA_HOST=http://localhost:11434

# Storage
DATA_PATH=./data
MAX_FILE_SIZE_MB=50
```

---

## 13. Testing Strategy

### 13.1 Test Structure

```
tests/
├── unit/
│   ├── lib/
│   │   ├── ai/
│   │   │   ├── tagger.test.ts
│   │   │   └── clusterer.test.ts
│   │   └── db/
│   │       └── queries.test.ts
│   └── components/
│       ├── EntryCard.test.tsx
│       └── QuickAdd.test.tsx
├── integration/
│   ├── api/
│   │   ├── entries.test.ts
│   │   └── search.test.ts
│   └── db/
│       └── migrations.test.ts
└── e2e/
    ├── inbox.spec.ts
    ├── reflection.spec.ts
    └── library.spec.ts
```

### 13.2 Unit Test Example

```typescript
// tests/unit/lib/ai/tagger.test.ts
import { describe, it, expect, vi } from 'vitest';
import { generateTags } from '@/lib/ai/tagger';

describe('generateTags', () => {
  it('should generate relevant tags for text content', async () => {
    const content = 'I practiced deep work today and achieved great focus.';
    const tags = await generateTags(content);

    expect(tags).toContain('focus');
    expect(tags).toContain('productivity');
    expect(tags.length).toBeGreaterThanOrEqual(2);
    expect(tags.length).toBeLessThanOrEqual(5);
  });

  it('should handle empty content', async () => {
    const tags = await generateTags('');
    expect(tags).toHaveLength(0);
  });
});
```

### 13.3 E2E Test Example

```typescript
// tests/e2e/inbox.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Inbox', () => {
  test('should create a new entry', async ({ page }) => {
    await page.goto('/inbox');

    const quickAdd = page.getByPlaceholder('Quick add...');
    await quickAdd.fill('Test entry content');
    await quickAdd.press('Enter');

    await expect(page.getByText('Test entry content')).toBeVisible();
  });

  test('should filter entries by content type', async ({ page }) => {
    await page.goto('/inbox');

    await page.getByRole('button', { name: 'Media' }).click();

    const entries = page.getByTestId('entry-card');
    await expect(entries.first()).toContainText('Photo');
  });
});
```

---

## 14. Development Guidelines

### 14.1 Code Style

```typescript
// Use TypeScript strict mode
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true
  }
}

// Naming conventions
interface UserData {}        // PascalCase for types/interfaces
function getUserById() {}    // camelCase for functions
const MAX_SIZE = 100;        // UPPER_SNAKE_CASE for constants

// File naming
// Components: PascalCase (EntryCard.tsx)
// Utilities: camelCase (formatDate.ts)
// API routes: kebab-case (user-profile.ts)
```

### 14.2 Git Workflow

```bash
# Branch naming
feature/inbox-quick-add
fix/search-performance
refactor/db-queries

# Commit messages (Conventional Commits)
feat(inbox): add voice recording support
fix(search): improve query performance
docs(api): update endpoint documentation
test(e2e): add reflection flow tests
```

### 14.3 Performance Budgets

```javascript
// next.config.js
module.exports = {
  experimental: {
    bundleSizeLimit: 250000, // 250KB per page
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    deviceSizes: [640, 750, 828, 1080, 1200],
  },
};
```

---

**End of Technical Design Document**

---

## Appendix A: Migration Scripts

```typescript
// lib/db/migrations/001_initial.ts
export async function up(db: Database) {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

export async function down(db: Database) {
  db.exec(`DROP TABLE users;`);
}
```

## Appendix B: API Client SDK

```typescript
// sdk/client.ts
export class MyLifeDBClient {
  constructor(private baseURL: string, private apiKey: string) {}

  async createEntry(data: CreateEntryInput): Promise<Entry> {
    return this.request('POST', '/api/v1/entries', data);
  }

  async searchEntries(query: SearchQuery): Promise<SearchResult[]> {
    return this.request('POST', '/api/v1/search', query);
  }

  private async request(method: string, path: string, data?: unknown) {
    const response = await fetch(`${this.baseURL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`);
    }

    return response.json();
  }
}
```

---

**Revision History**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.1 | 2025-10-28 | Engineering Team | Added URL crawl implementation, file system indexing strategy, dual search (Meilisearch + Qdrant), destination classification, alternatives analysis |
| 1.0 | 2025-10-15 | Engineering Team | Initial technical design |
