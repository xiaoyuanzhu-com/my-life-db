# MyLifeDB

> folders and files, that's it.

what's behind:

* app adapt to you, not the other way around.
* use your favorite apps, at the same time.
* zero vendor lock-in.

## Conventions

### Data Directory Structure

MyLifeDB separates user data from application data:

```
USER_DATA_DIR/        # User files (source of truth)
├── inbox/            # Unprocessed items waiting for organization
├── notes/            # Your organized content
├── journal/          # Your organized content
└── ...               # Other library folders

APP_DATA_DIR/         # Application data (rebuildable, separate)
└── database.sqlite   # SQLite database
```

**Important**: The app data directory (`APP_DATA_DIR`) contains only rebuildable data. You can delete it and the app will recreate indexes, database, etc. from the source files in your user data directory.

### Reserved Folders

- **inbox/** - Unprocessed items waiting for organization (in USER_DATA_DIR)
- All folders starting with `.` (like `.my-life-db`, `.obsidian`, `.git`) are automatically excluded from indexing

All other folders in the user data directory are considered library content and are indexed by the application.

### README.md

Each folder can have a README.md to describe the purpose of the folder, its structure, and any other relevant information.

---

A filesystem-based personal knowledge management system built with Go and React.

## Features

### Currently Implemented

- ✅ **File Management**: Browse, organize, and manage files in a directory-based structure
- ✅ **Inbox**: Capture files and content without upfront organization
- ✅ **Library**: Browse and manage organized directories
- ✅ **Full-Text Search**: Search across all files (with Meilisearch integration)
- ✅ **File Digestion**: Automatic processing of PDFs, EPUBs, images, and markdown files
- ✅ **Filesystem-First**: SQLite metadata + file-based storage (source of truth)
- ✅ **Real-time Notifications**: SSE-based updates for file changes
- ✅ **Background Workers**: Automatic file watching and digest processing
- ✅ **File Pinning**: Pin important files in inbox and library
- ✅ **File Upload**: TUS protocol for resumable uploads

### Coming Soon

- ⏭️ AI-powered file enrichment
- ⏭️ Semantic search with vector embeddings
- ⏭️ People management and tagging
- ⏭️ Advanced search filters
- ⏭️ File export capabilities

## Tech Stack

- **Backend**: Go 1.25 with Gin framework
- **Frontend**: React Router 7 (SPA mode) + React 19 + TypeScript
- **UI**: Tailwind CSS 4 + shadcn/ui
- **Data**: SQLite (metadata) + Filesystem (source of truth)
- **Background Workers**: Go routines with fsnotify file watching
- **File Processing**: Custom digest worker with pluggable digesters
- **Real-time**: Server-Sent Events (SSE)
- **Build**: Vite (frontend) + Go compiler (backend)

## Getting Started

### Prerequisites

- Go 1.25+
- Node.js 22+ (for frontend development)
- npm

### Installation

#### Option 1: Docker (Recommended)

```bash
# Create directories with correct ownership
# The container runs as UID/GID 1000 for host compatibility
mkdir -p data app-data
sudo chown -R 1000:1000 data app-data

# Create docker-compose.yml
cat > docker-compose.yml << 'EOF'
services:
  mylifedb:
    image: ghcr.io/xiaoyuanzhu-com/my-life-db:latest
    container_name: mylifedb
    ports:
      - 12345:12345
    volumes:
      - ./data:/home/xiaoyuanzhu/my-life-db/data
      - ./app-data:/home/xiaoyuanzhu/my-life-db/.my-life-db
    restart: unless-stopped
    environment:
      - USER_DATA_DIR=/home/xiaoyuanzhu/my-life-db/data
      - APP_DATA_DIR=/home/xiaoyuanzhu/my-life-db/.my-life-db
EOF

# Start the container
docker-compose up -d
```

**Note on Permissions**: The Docker image runs as UID/GID 1000 (non-root) for security. If you encounter permission issues:
- Ensure directories are owned by UID 1000: `sudo chown -R 1000:1000 ./data ./app-data`
- Or if your user is UID 1000 (common on Linux), just: `mkdir -p data app-data && chmod 775 data app-data`

Visit [http://localhost:12345](http://localhost:12345) to see the app.

#### Option 2: Local Development

```bash
# Terminal 1: Build frontend
cd frontend
npm install
npm run build

# Terminal 2: Run Go backend (serves frontend + API)
cd backend
go run .
```

Visit [http://localhost:12345](http://localhost:12345) to see the app.

For frontend development with hot reload:
```bash
# Terminal 1: Frontend dev server
cd frontend && npm run dev

# Terminal 2: Go backend
cd backend && go run .
```

### First Steps

1. **Upload files**: Drop files into the inbox or library folders
2. **View your Inbox**: Click "Inbox" to see unprocessed files
3. **Browse Library**: Click "Library" to browse organized directories
4. **Create folders**: Use the UI to create new library folders
5. **File digestion**: Files are automatically processed in the background
6. **Pin files**: Pin important files for quick access

### Search Services (Optional)

MyLifeDB can integrate with external search services for enhanced functionality:

**Meilisearch** (full-text search):
```bash
MEILI_HOST=http://localhost:7700
MEILI_API_KEY=masterKey
```

**Qdrant** (vector search):
```bash
QDRANT_HOST=http://localhost:6333
QDRANT_API_KEY=your-key
```

**HAID** (web crawling & embeddings):
```bash
HAID_BASE_URL=http://localhost:12310
HAID_API_KEY=your-key
```

**OpenAI** (AI features):
```bash
OPENAI_API_KEY=your-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

## File Storage

Files are stored in the user data directory with metadata tracked in SQLite. The filesystem is the source of truth - you can edit files directly with any application.

## Data Ownership

All your data is stored locally with complete ownership and portability:

- ✅ **Filesystem-first**: Files are stored in your data directory, not in a database
- ✅ **Edit anywhere**: Use any text editor or file manager to modify your files
- ✅ **Easy backup**: Simply copy the `USER_DATA_DIR` folder
- ✅ **Version control**: Use Git to track changes to your files
- ✅ **Zero vendor lock-in**: All data is in standard formats (Markdown, JSON, etc.)
- ✅ **Rebuildable metadata**: Delete `APP_DATA_DIR` anytime - it will rebuild from your files

## Documentation

- [CLAUDE.md](./CLAUDE.md) - Development guide for Claude Code
- [Backend Architecture](./docs/backend-arch.md) - Server architecture documentation
- [Module Interfaces](./docs/module-interfaces.md) - Module specifications

## API Endpoints

All API routes are defined in [backend/api/routes.go](backend/api/routes.go). Key endpoints:

### Inbox
- `GET /api/inbox` - List inbox files
- `GET /api/inbox/:id` - Get inbox file details
- `POST /api/inbox/:id/pin` - Pin/unpin inbox file
- `POST /api/inbox/:id/re-enrich` - Re-run digestion

### Library
- `GET /api/library/tree` - Get directory tree
- `GET /api/library/files` - List files in a folder
- `GET /api/library/file` - Get file details
- `POST /api/library/file/pin` - Pin/unpin library file
- `POST /api/library/folder` - Create folder
- `PUT /api/library/file/move` - Move file
- `PUT /api/library/file/rename` - Rename file

### Digest
- `GET /api/digest/registry` - List available digesters
- `GET /api/digest/stats` - Digest processing statistics
- `POST /api/digest/trigger` - Manually trigger digest for a file

### People
- `GET /api/people` - List people
- `POST /api/people` - Create person
- `GET /api/people/:id` - Get person details
- `PUT /api/people/:id` - Update person
- `DELETE /api/people/:id` - Delete person

### Search
- `GET /api/search` - Full-text search across files

### Upload
- `POST /api/upload/tus/*` - TUS protocol resumable file upload

### Notifications
- `GET /api/notifications/stream` - SSE event stream for real-time updates

### Files
- `GET /raw/*path` - Serve raw file from data directory
- `GET /sqlar/*path` - Serve file from SQLAR archive


## License

MIT
