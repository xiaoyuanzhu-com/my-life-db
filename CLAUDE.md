# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MyLifeDB is a filesystem-based personal knowledge management system with:
- **Frontend**: React Router 7 + React 19 + TypeScript + Tailwind CSS 4 (in `frontend/`)
- **Backend**: Go HTTP server with SQLite (in `backend/`)

The backend provides all API endpoints, background workers, and static file serving. The frontend is a React SPA that communicates with the backend API.

## Common Commands

### Frontend (in `frontend/` directory)
```bash
npm run dev          # Start dev server with Vite HMR (http://localhost:12345)
npm run build        # Build production React app
npm run build:client # Build client-only (for Go backend)
npm run lint         # Run ESLint
npm run typecheck    # Generate types + run TypeScript compiler
```

### Backend (in `backend/` directory)
```bash
make dev             # Run Go server in development mode
make build           # Build frontend + Go server
make build-server    # Build Go server only → ../bin/server
make test            # Run Go tests
make lint            # Run Go linter
```

### Full Stack
```bash
# Development: Run Go backend (serves built frontend)
cd backend && make dev

# Production: Build everything, then run
cd backend && make build && ../bin/server
```

## Architecture

### Project Structure
```
my-life-db/
├── frontend/           # React Router 7 SPA
│   ├── app/
│   │   ├── .server/    # Server-side code (SSR loaders, init)
│   │   ├── components/ # UI components
│   │   ├── routes/     # File-based routing (api.*.ts, pages)
│   │   ├── lib/        # Client utilities
│   │   └── types/      # TypeScript types
│   ├── server.js       # Express + Vite dev server
│   └── package.json
├── backend/            # Go HTTP server
│   ├── api/            # HTTP handlers (35+ endpoints)
│   ├── db/             # SQLite database layer
│   ├── workers/        # Background workers (fs watcher, digest)
│   ├── vendors/        # External clients (Meilisearch, Qdrant, OpenAI)
│   ├── notifications/  # SSE service
│   └── main.go
└── docs/               # Product and technical design docs
```

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
- Uses better-sqlite3 (frontend) or mattn/go-sqlite3 (backend)
- Core tables: `files`, `digests`, `sqlar`, `meili_documents`, `settings`

## Naming Conventions

| Category | Convention | Examples |
|----------|-----------|----------|
| Files | `kebab-case.ts/tsx` | `file-card.tsx`, `url-crawler.ts` |
| Types/Interfaces | `PascalCase` | `FileRecord`, `Digest` |
| Functions/Variables | `camelCase` | `getFileByPath()`, `filePath` |
| Constants | `SCREAMING_SNAKE_CASE` | `DATA_ROOT`, `INBOX_DIR` |
| DB columns | `snake_case` | `file_path`, `created_at` |
| Go files | `snake_case.go` | `inbox.go`, `file_watcher.go` |

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
| MY_DATA_DIR | ./data | Data directory |
| MEILI_HOST | | Meilisearch URL |
| QDRANT_HOST | | Qdrant URL |
| OPENAI_API_KEY | | OpenAI API key |
| DEBUG | | Comma-separated module names for debug logging |

## Debug Logging

Enable debug logs for specific modules:
```bash
DEBUG=VendorOpenAI,DigestWorker ./bin/server
```

## Git Workflow

Do NOT create git commits automatically. Only commit when explicitly instructed.

## Development Server

The user typically has a development server running. Check before starting a new one.

## Design Preferences

- **Minimal Borders**: Keep the UI clean with few dividers and borders.
