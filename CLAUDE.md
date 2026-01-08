# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MyLifeDB is a filesystem-based personal knowledge management system with:
- **Frontend**: React Router 7 (SPA mode) + React 19 + TypeScript + Tailwind CSS 4 + Vite (in `frontend/`)
- **Backend**: Go 1.25 HTTP server (Gin) with SQLite (in `backend/`)

The backend provides all API endpoints, background workers (file system watcher, digest processor), SSE notifications, and static file serving. The frontend is a client-rendered React SPA that communicates with the backend API.

## Common Commands

### Frontend (in `frontend/` directory)
```bash
npm run dev        # Start Vite dev server (http://localhost:12345)
npm run build      # Build production React app → dist/
npm run lint       # Run ESLint
npm run typecheck  # Run TypeScript compiler
```

### Backend (in `backend/` directory)
```bash
go run .          # Run Go server in development mode
go build .        # Build Go server → my-life-db binary
go test -v ./...  # Run Go tests
go vet ./...      # Run Go linter
```

### Full Stack Development
```bash
# Terminal 1: Build frontend once or run in watch mode
cd frontend && npm run build

# Terminal 2: Run Go backend (serves built frontend from frontend/dist/)
cd backend && go run .

# Production: Build everything, then run
cd frontend && npm run build && cd ../backend && go build . && ./my-life-db
```

## Architecture

### Project Structure
```
my-life-db/
├── frontend/           # React Router 7 SPA (client-rendered)
│   ├── app/
│   │   ├── components/ # UI components (shadcn/ui + custom)
│   │   ├── routes/     # File-based routing (home, inbox, library, etc.)
│   │   ├── contexts/   # React contexts (auth, etc.)
│   │   ├── hooks/      # Custom React hooks
│   │   ├── lib/        # Client utilities
│   │   ├── types/      # TypeScript types
│   │   └── root.tsx    # Root layout with Header + AuthProvider
│   ├── vite.config.ts  # Vite bundler config
│   └── package.json
├── backend/            # Go 1.25 HTTP server (Gin framework)
│   ├── api/            # HTTP handlers (~40 endpoints in routes.go)
│   ├── auth/           # OAuth implementation
│   ├── config/         # Configuration management
│   ├── db/             # SQLite database layer + migrations
│   ├── log/            # Structured logging (zerolog)
│   ├── models/         # Domain models
│   ├── notifications/  # SSE service for real-time updates
│   ├── utils/          # Shared utilities
│   ├── vendors/        # External clients (Meilisearch, Qdrant, OpenAI, HAID)
│   ├── workers/
│   │   ├── digest/     # Digest processor worker + digester registry
│   │   └── fs/         # File system watcher (fsnotify)
│   ├── go.mod
│   └── main.go         # Entry point
└── docs/               # Product and technical design docs
```

### Background Workers

The backend runs two concurrent workers:

1. **FS Worker** (`workers/fs/`): Watches the data directory for file changes using fsnotify, scans periodically (hourly), and notifies the digest worker of changes.

2. **Digest Worker** (`workers/digest/`): Processes files through registered digesters (e.g., markdown, PDF, EPUB, images). Uses a registry pattern with 3 parallel processing goroutines. Supervisors ensure pending digests are eventually processed.

### Data Storage
```
MY_DATA_DIR/
├── inbox/              # Unprocessed files (source of truth)
├── notes/, journal/... # User library folders (source of truth)
└── app/my-life-db/     # Rebuildable app data
    └── database.sqlite
```

**Key principles:**
- Filesystem is the source of truth (inbox + library folders)
- `app/` contains rebuildable data (can be deleted and rebuilt)
- Files referenced by relative paths, no synthetic IDs

### Database (SQLite)
- Location: `MY_DATA_DIR/app/my-life-db/database.sqlite`
- Driver: mattn/go-sqlite3 with CGO_ENABLED=1 (required for build)
- Core tables: `files`, `digests`, `sqlar` (archive format), `pins`, `people`, `settings`
- Migration system in `db/migrations.go`

## Naming Conventions

| Category | Convention | Examples |
|----------|-----------|----------|
| Files | `kebab-case.ts/tsx` | `file-card.tsx`, `url-crawler.ts` |
| Types/Interfaces | `PascalCase` | `FileRecord`, `Digest` |
| Functions/Variables | `camelCase` | `getFileByPath()`, `filePath` |
| Constants | `SCREAMING_SNAKE_CASE` | `DATA_ROOT`, `INBOX_DIR` |
| DB columns | `snake_case` | `file_path`, `created_at` |
| Go files | `snake_case.go` | `inbox.go`, `file_watcher.go` |

## Frontend Architecture

### React Router 7 (SPA Mode)
- **Client-side only**: No SSR, all rendering happens in the browser
- **File-based routing**: Routes defined in `frontend/app/routes/` (e.g., `home.tsx`, `inbox.tsx`, `library.browse.tsx`)
- **Root layout**: `root.tsx` provides the app shell (Header + AuthProvider + Outlet)
- **Data fetching**: Uses TanStack Query for API calls, NOT React Router loaders
- **No server-side code**: All API calls go to the Go backend

### Key Frontend Patterns
- Use `@tanstack/react-query` for data fetching and caching
- Context providers in `app/contexts/` (e.g., AuthContext)
- Custom hooks in `app/hooks/`
- shadcn/ui components in `app/components/ui/`

## Dark Mode (IMPORTANT)

This project uses **CSS media query-based dark mode**, NOT class-based.

```tsx
// WRONG - dark: variant won't work (no .dark class)
className="bg-white dark:bg-zinc-900"

// CORRECT - use semantic variables
className="bg-background text-foreground"
className="bg-muted border-border"

// For status colors, use opacity
className="bg-destructive/10 border-destructive/30"
```

Available semantic colors: `background`, `foreground`, `card`, `muted`, `primary`, `destructive`, `border`, `input`, `ring`

## UI Components (shadcn/ui)

Always use the CLI to add new components:
```bash
cd frontend && npx shadcn@latest add <component-name>
```

Never create shadcn components manually.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 12345 | Server port |
| HOST | 0.0.0.0 | Server host |
| ENV | development | Environment (development/production) |
| MY_DATA_DIR | ./data | Data directory root |
| MEILI_HOST | | Meilisearch URL (optional) |
| QDRANT_URL | | Qdrant URL (optional) |
| QDRANT_API_KEY | | Qdrant API key (optional) |
| OPENAI_API_KEY | | OpenAI API key (optional) |
| HAID_BASE_URL | | HAID embedding service URL (optional) |
| HAID_API_KEY | | HAID API key (optional) |

## API Routes

All API routes are defined in [backend/api/routes.go](backend/api/routes.go). Key endpoints:

| Group | Routes | Description |
|-------|--------|-------------|
| Auth | `/api/auth/*` | Login/logout |
| OAuth | `/api/oauth/*` | OAuth flow (authorize, callback, token, refresh) |
| Inbox | `/api/inbox`, `/api/inbox/:id` | Inbox CRUD + pinning + re-enrichment |
| Library | `/api/library/*` | File management, tree structure, pinning |
| Digest | `/api/digest/*` | Digester registry, stats, trigger digests |
| People | `/api/people`, `/api/people/:id` | Person management + embeddings |
| Search | `/api/search` | Full-text search |
| Upload | `/api/upload/tus/*` | TUS protocol file uploads |
| Notifications | `/api/notifications/stream` | SSE event stream |
| Raw Files | `/raw/*path` | Serve/save raw files from data directory |
| SQLAR | `/sqlar/*path` | Serve files from SQLAR archives |

## Logging

The backend uses structured logging via zerolog:
- Info/Error/Debug logs go to stdout
- Includes Gin request logging middleware
- Logs are in JSON format in production, pretty-printed in development

## Git Workflow

Do NOT create git commits automatically. Only commit when explicitly instructed.

## Development Server

The user typically has a development server running. Check before starting a new one.

## Design Preferences

- **Minimal Borders**: Keep the UI clean with few dividers and borders.

## Development Principles (CRITICAL)

### Respect User Configuration
1. **Honor user settings exactly as provided** - Never automatically "fix" or convert user-provided configuration values
2. **User agency over assumptions** - If a setting seems wrong, let the error surface rather than silently correcting it
3. **Explicit is better than implicit** - If conversion/transformation is needed, ask the user first or document it clearly
4. **Configuration is intentional** - Assume the user knows what they're doing; they can debug their own config errors

### When Working with External Services
1. **Pass through settings as-is** - Only add minimal normalization (e.g., trimming trailing slashes for robustness)
2. **Don't assume defaults for user-provided values** - Only apply defaults when values are completely absent
3. **Avoid "helpful" transformations** - Don't convert ports, URLs, or other values based on your knowledge of how services "should" work
4. **Let libraries handle their own requirements** - If a library needs data in a specific format, document that requirement rather than auto-converting

### Problem-Solving Approach
1. **Listen before acting** - If the user says something is configured, trust that first
2. **Simple solutions first** - Avoid overengineering; prefer straightforward pass-through of values
3. **Ask when uncertain** - When you discover a potential issue (like port mismatches), ask rather than assume
4. **Incomplete information is not permission to guess** - Stop and clarify rather than filling in gaps with assumptions

### Examples of Good vs Bad Behavior

**BAD:**
```go
// User configured port 6333, but I "know" Qdrant uses 6334 for gRPC
if port == "6333" {
    port = "6334"  // Automatic "correction"
}
```

**GOOD:**
```go
// Use exactly what the user configured
portNum, _ := strconv.Atoi(port)
```

**BAD:**
- Researching how a service works, then "correcting" user config based on that research
- Adding complex parsing/transformation logic "for convenience"
- Silently falling back to different values than configured

**GOOD:**
- Pass through configuration values with minimal normalization
- Trust errors will guide the user to fix their config
- Document requirements clearly if the library needs specific formats
