# MyLifeDB

> folders and files, that's it.

what's behind:

* app adapt to you, not the other way around.
* use your favorite apps, at the same time.
* zero vendor lock-in.

## Conventions

### .app folder

Every app can have its own folder to store app-specific data, settings, cache, etc.

### README.md

Each folder can have a README.md to describe the purpose of the folder, its structure, and any other relevant information.

---

A filesystem-based personal knowledge management system built with Next.js 15, React 19, and TypeScript.

## Features

### MVP (Currently Implemented)

- ✅ **Text Capture**: Quick-add text entries with auto-save
- ✅ **Directory-Based Organization**: Organize entries into filesystem directories
- ✅ **Inbox**: Capture thoughts without upfront organization
- ✅ **Library**: Browse and manage organized directories
- ✅ **Full-Text Search**: Search across all entries
- ✅ **Markdown Storage**: All entries stored as markdown files
- ✅ **Filesystem-First**: SQLite metadata + file-based storage
- ✅ **URL Crawling**: Automatic web page crawling with background processing
- ✅ **Task Queue**: Robust background job processing with retry logic
- ✅ **AI Slug Generation**: Smart naming for saved URLs (with fallbacks)

### Coming Soon

- ⏭️ AI Tagging with OpenAI
- ⏭️ Voice/File Upload
- ⏭️ Export to ZIP
- ⏭️ Entry Filing (move entries between directories)
- ⏭️ Advanced Search with Filters
- ⏭️ Screenshot capture for URLs
- ⏭️ Embeddings generation

## Tech Stack

- **Framework**: Next.js 15.5.5 with App Router
- **UI**: React 19, Tailwind CSS 4
- **Language**: TypeScript 5.7+
- **Data**: SQLite (metadata) + Filesystem (Markdown + JSON)
- **Background Jobs**: Custom task queue with exponential backoff
- **Validation**: Zod
- **State**: React Hooks
- **Date Handling**: date-fns

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) to see the app.

### First Steps

1. **Capture your first entry**: Use the Quick Capture form on the homepage
2. **Save a URL**: Add a URL to the inbox - it will be automatically crawled and processed
3. **View your Inbox**: Click "Inbox" in the navigation to see all captured entries
4. **Create a directory**: Go to "Library" and click "New Directory"
5. **Organize**: Move entries from Inbox to your directories (coming soon)

### URL Crawling

When you add a URL to the inbox, the system automatically:
- Fetches and parses the web page
- Extracts metadata (title, description, author, etc.)
- Converts HTML to Markdown
- Generates a smart slug using AI (falls back to metadata if AI is unavailable)
- Saves files: `content.html`, `content.md`, `main-content.md`
- Renames the folder from UUID to human-readable slug

Monitor processing with the task queue API:
```bash
# Check task status
curl http://localhost:3000/api/tasks/stats

# List all tasks
curl http://localhost:3000/api/tasks
```

## File Storage

All entries are stored as Markdown files with frontmatter metadata. See documentation for details.

## Data Ownership

All your data is stored locally in the `data/` directory as human-readable Markdown and JSON files. You can:

- ✅ Directly edit files in any text editor
- ✅ Backup by copying the `data/` directory
- ✅ Version control with Git (data directory is gitignored)
- ✅ Export and migrate without vendor lock-in

## Documentation

- [Product Design Document](./docs/product-design.md)
- [Technical Design Document](./docs/tech-design.md)
- [MVP Implementation Guide](./docs/mvp.md)
- [Task Queue Implementation](./src/lib/task-queue/IMPLEMENTATION.md) - Background job processing architecture

## API Endpoints

### Inbox
- `GET /api/inbox` - List inbox items
- `POST /api/inbox` - Create inbox item (auto-processes URLs)
- `GET /api/inbox/[id]` - Get inbox item
- `PUT /api/inbox/[id]` - Update inbox item
- `DELETE /api/inbox/[id]` - Delete inbox item

### Task Queue
- `GET /api/tasks` - List tasks with filtering
- `POST /api/tasks` - Create task manually
- `GET /api/tasks/[id]` - Get task details
- `DELETE /api/tasks/[id]` - Delete task
- `GET /api/tasks/stats` - Task statistics
- `GET /api/tasks/worker/status` - Worker status
- `POST /api/tasks/worker/pause` - Pause worker
- `POST /api/tasks/worker/resume` - Resume worker

## License

MIT
