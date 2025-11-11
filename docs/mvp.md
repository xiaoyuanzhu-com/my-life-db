# MVP Implementation Guide: MyLifeDB

**Version:** 1.0
**Last Updated:** 2025-10-15
**Owner:** Engineering Team

---

## Table of Contents

1. [MVP Goals](#1-mvp-goals)
2. [Pages & Routes](#2-pages--routes)
3. [Features Implementation](#3-features-implementation)
4. [Data Models](#4-data-models)
5. [Common Patterns](#5-common-patterns)

---

## 1. MVP Goals

**Prove Core Value:** Users can capture thoughts effortlessly and organize them with AI assistance.

**What's In:**
- ✅ Text capture with quick-add
- ✅ Auto-save
- ✅ AI tagging (2-3 tags per entry)
- ✅ Directory-based organization
- ✅ Entry filing to directories
- ✅ Full-text search
- ✅ Export to Markdown
- ✅ Filesystem storage

**What's Out:**
- ⏭️ Voice/file upload
- ⏭️ AI clustering
- ⏭️ Insights & Principles
- ⏭️ Weekly digest
- ⏭️ Integrations

---

## 2. Pages & Routes

### 2.1 Main Application Pages
- `/` - Homepage (default landing) - combined input, quick insights, and search
- `/inbox` - Full Inbox view
- `/library` - Library overview (directory browser)
- `/library/[dirPath]` - Directory detail view
- `/search` - Advanced search results page

### 2.2 Settings
- `/settings` - User settings (AI config, export)

---

## 3. Features Implementation

### 3.1 Homepage
- Quick-add input (prominent)
- Global search bar
- Quick insights panel (recent entries count, suggested directories)
- Recent entries preview (last 5-10)
- Quick access to directories

### 3.2 Inbox (Entry Capture)
- Quick-add bar (always visible)
- Entry list view
- Entry card component
- Create entry (text only)
- Edit entry
- Delete entry
- Auto-save functionality
- Entry metadata (timestamp, tags)

### 3.3 AI Tagging
- OpenAI integration
- Generate 2-3 tags per entry
- Tag suggestions UI
- Accept/reject tag suggestions
- Confidence display

### 3.4 Library (Directory Browser)
- Directory tree navigation
- Create directory
- Rename directory
- Delete directory
- Archive directory
- Directory detail view
- Directory card component

### 3.5 Entry Filing
- Move entry to directory
- Copy entry to multiple directories
- View entries in directory
- Filesystem-based organization

### 3.6 Search
- Global search bar (⌘K shortcut)
- Full-text search across all files
- Filter by date range
- Filter by directory
- Search results list
- Result highlighting

### 3.7 Export
- Export single directory to ZIP
- Export all data (native filesystem copy)
- Already in Markdown format

### 3.8 UI Components
- Quick-add input
- Entry card
- Directory card
- Search bar
- Filter panel
- Modal dialogs
- Toast notifications
- Loading states

---

## 4. Data Models

### 4.1 Message Types

MyLifeDB supports the following message types:

| Type | Description | Examples | Status |
|------|-------------|----------|--------|
| **text** | Plain text content only | Quick notes, thoughts, journal entries | ✅ Implemented |
| **url** | Web link with optional preview | Bookmarks, articles, references | 🚧 Planned |
| **image** | Image file with optional caption | Photos, screenshots, diagrams | ✅ Implemented |
| **audio** | Audio recording | Voice notes, recordings | 🚧 Planned |
| **video** | Video file | Video clips, recordings | 🚧 Planned |
| **pdf** | PDF document | Documents, papers, receipts | 🚧 Planned |
| **mixed** | Text combined with attachments | Notes with images, text with PDFs | ✅ Implemented |

**Terminology:**
- **Message**: What the user sends/creates (the input)
- **Entry**: The stored message with metadata (the persisted data)
- **Attachment**: Files associated with a message (images, PDFs, etc.)

### 4.2 Filesystem Structure

```
MY_DATA_DIR/
├── app/
│   └── mylifedb/
│       └── inbox/                  # Temporary staging (no date layer)
│           └── {folderName}/       # UUID initially, may become AI slug
│               ├── text.md         # Text input (if provided)
│               └── [files]         # Uploaded and generated files (e.g., url.txt, content.html)
└── {user-content}/                 # User-owned library (free-form structure)
    ├── notes/
    ├── projects/
    └── ...
```

### 4.3 TypeScript Types

**Message Metadata:**
```typescript
interface MessageMetadata {
  id: string;                    // UUID v4
  type: MessageType;             // Type of message
  slug: string | null;           // AI-generated URL-safe slug
  title: string | null;          // AI-generated title
  createdAt: string;             // ISO timestamp
  updatedAt: string;
  tags: string[];

  ai: {
    processed: boolean;
    title: string | null;
    summary: string | null;
    tags: string[];
    // ... extraction results
  };

  attachments: Array<{
    filename: string;
    mimeType: string;
    size: number;
    type: 'image' | 'audio' | 'video' | 'pdf' | 'other';
    ai?: {
      caption?: string;
      ocr?: string;
      transcription?: string;
    };
  }>;
}

type MessageType =
  | 'text'      // Plain text only
  | 'url'       // Web link
  | 'image'     // Single image (no text)
  | 'audio'     // Audio recording
  | 'video'     // Video file
  | 'pdf'       // PDF document
  | 'mixed';    // Text + attachments
```

### 4.4 File Formats

**text.md:**
```markdown
This is the message content in plain markdown format.
No frontmatter, just clean content.
```

**metadata.json:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "mixed",
  "slug": null,
  "title": null,
  "createdAt": "2025-10-15T10:30:00.000Z",
  "updatedAt": "2025-10-15T10:30:00.000Z",
  "tags": [],
  "ai": {
    "processed": false,
    "processedAt": null,
    "title": null,
    "tags": [],
    "summary": null
  },
  "attachments": [
    {
      "filename": "screenshot.png",
      "mimeType": "image/png",
      "size": 524288,
      "type": "image"
    }
  ]
}
```

---

## 5. Common Patterns

### 5.1 File Operations
### 5.2 Directory Navigation
### 5.3 Error Handling
### 5.4 Loading States

---

**For complete requirements:** [product-design.md](./product-design.md)
**For technical architecture:** [tech-design.md](./tech-design.md)
