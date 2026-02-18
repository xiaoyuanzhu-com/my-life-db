# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Documentation

All project documentation lives in `../my-life-db-docs/` (Astro Starlight site). Key sections for code changes:

- **Architecture** — System overview, backend architecture, tech design, module interfaces
- **Components** — Deep dives into subsystems: claude-code, digest-system, fs-service, notifications, auth, etc.
- **API** — REST API reference, HTTP caching
- **Features** — Inbox, search, digest, voice, people, and more

Read the architecture overview first, then the relevant component doc for your task.

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

### run.js Helper Script
```bash
./run.js frontend           # Start frontend dev server
./run.js frontend --watch   # Start + auto-restart on git changes
./run.js backend            # Build and start backend (loads .env automatically)
./run.js backend --watch    # Start + auto-restart on git changes
./run.js meili              # Start Meilisearch via Docker
./run.js github             # Start GitHub webhook listener (for staging)
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
│   ├── agent/          # Inbox agent (AI-driven file intention analysis)
│   ├── api/            # HTTP handlers (50+ endpoints in routes.go)
│   │   └── handlers.go # Handlers struct with server reference
│   ├── auth/           # OAuth/OIDC authentication
│   ├── claude/         # Claude Code integration (session management, WebSocket, message parsing)
│   ├── config/         # Configuration management
│   ├── db/             # SQLite database layer + migrations
│   ├── fs/             # Filesystem service
│   ├── log/            # Structured logging (zerolog)
│   ├── notifications/  # SSE service for real-time updates
│   ├── server/         # Server struct - owns all components
│   │   ├── server.go   # Server lifecycle & component management
│   │   └── config.go   # Server configuration
│   ├── utils/          # Shared utilities
│   ├── vendors/        # External clients (Meilisearch, OpenAI, HAID, Aliyun)
│   ├── workers/
│   │   └── digest/     # Digest processor worker + digester registry
│   ├── go.mod
│   └── main.go         # Entry point - creates Server and wires routes
└── run.js              # Helper script for running services (Node.js)
```

### Server Architecture

The backend uses a **server-centric architecture** where a `server.Server` struct owns and coordinates all application components:

```go
// server/server.go
type Server struct {
    cfg *Config

    // Components (owned by server)
    database      *db.DB
    fsService     *fs.Service
    digestWorker  *digest.Worker
    notifService  *notifications.Service
    claudeManager *claude.SessionManager
    agent         *agent.Agent

    // Shutdown context - cancelled when server is shutting down.
    // Long-running handlers (WebSocket, SSE) should listen to this.
    shutdownCtx    context.Context
    shutdownCancel context.CancelFunc

    // HTTP
    router *gin.Engine
    http   *http.Server
}
```

**Key principles:**
- **No global singletons** (except logging) - all stateful components are owned by Server
- **Explicit dependencies** - components receive dependencies via constructors
- **Clear lifecycle** - Server manages initialization order and graceful shutdown
- **Dependency injection** - API handlers receive Server reference via `api.Handlers` struct

**Component initialization order (inside `server.New()`):**
1. Database (`db.Open()`)
2. Load user settings + apply log level
3. Notifications service (`notifications.NewService()`)
4. Claude session manager (`claude.NewSessionManager()`)
5. FS service (`fs.NewService()` with db reference)
6. Digest worker (`digest.NewWorker()` with db + notifications)
7. Agent (`agent.New()`, if `MLD_INBOX_AGENT=1`)
8. Wire event handlers between components
9. Setup Gin router

**API handlers pattern:**
```go
// api/handlers.go
type Handlers struct {
    server *server.Server
}

func (h *Handlers) GetInbox(c *gin.Context) {
    // Access components via h.server
    fs := h.server.FS()
    db := h.server.DB()
    // ...
}
```

**Main.go flow:**
1. Load config from environment (`config.Get()`)
2. Create `server.Config`
3. Create server with `server.New(cfg)` (initializes all components)
4. Setup search clients (`db.SetSearchClients()`)
5. Setup routes with `api.SetupRoutes(srv.Router(), handlers)`
6. Setup static file serving and SPA fallback
7. Start server with `srv.Start()`
8. Graceful shutdown with `srv.Shutdown(ctx)`

See the Architecture section in [`../my-life-db-docs/`](../my-life-db-docs/) for detailed architecture documentation.

### Background Workers

The backend runs two concurrent workers:

1. **FS Service** (`fs/`): Watches the data directory for file changes using fsnotify, scans periodically (hourly), and notifies the digest worker of changes via event handlers.

2. **Digest Worker** (`workers/digest/`): Processes files through registered digesters (e.g., markdown, PDF, EPUB, images). Uses a registry pattern with 3 parallel processing goroutines. Supervisors ensure pending digests are eventually processed.

### Data Storage
```
USER_DATA_DIR/          # User files (source of truth)
├── inbox/              # Unprocessed files
├── notes/              # User library folders
├── journal/            # User library folders
└── ...                 # Other user folders

APP_DATA_DIR/           # Rebuildable app data (separate from user data)
└── database.sqlite     # SQLite database
```

**Key principles:**
- User data directory (`USER_DATA_DIR`) is the source of truth (inbox + library folders)
- App data directory (`APP_DATA_DIR`) contains rebuildable data (can be deleted and rebuilt)
- Files referenced by relative paths, no synthetic IDs
- For Docker deployments, mount `APP_DATA_DIR` separately for persistence

### Database (SQLite)
- Location: `APP_DATA_DIR/database.sqlite`
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

This project uses **class-based dark mode** with `.dark` class on `<html>` element.

**How it works:**
- `ThemeToggle` component cycles between: `auto` → `light` → `dark`
- In `light`/`dark` mode: adds `.light` or `.dark` class to `<html>`
- In `auto` mode: removes classes, falls back to system preference via `matchMedia`
- CSS variables in `globals.css` define colors for `:root` (light) and `.dark` (dark)

```tsx
// CORRECT - use semantic variables (work in both themes)
className="bg-background text-foreground"
className="bg-muted border-border"

// For status colors, use opacity
className="bg-destructive/10 border-destructive/30"

// Tailwind dark: variant also works (via @custom-variant in globals.css)
className="bg-white dark:bg-zinc-900"
```

**For dynamic theme detection in JS:**
```ts
// Check if dark mode is active
const isDark = document.documentElement.classList.contains('dark') ||
  (!document.documentElement.classList.contains('light') &&
   window.matchMedia('(prefers-color-scheme: dark)').matches)
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
| USER_DATA_DIR | ./data | User data directory (inbox, notes, etc.) |
| APP_DATA_DIR | ./.my-life-db | App data directory (database, cache) |
| MEILI_HOST | | Meilisearch URL (optional) |
| MEILI_API_KEY | | Meilisearch API key (optional) |
| MEILI_INDEX | mylifedb_files | Meilisearch index name (optional) |
| OPENAI_API_KEY | | OpenAI API key (optional) |
| OPENAI_BASE_URL | https://api.openai.com/v1 | OpenAI base URL (optional) |
| OPENAI_MODEL | gpt-4o-mini | OpenAI model name (optional) |
| HAID_BASE_URL | | HAID service URL for OCR, ASR, etc. (optional) |
| HAID_API_KEY | | HAID API key (optional) |
| HAID_CHROME_CDP_URL | | Chrome CDP URL for HAID web crawling (optional) |
| MLD_AUTH_MODE | none | Auth mode: `none`, `password`, or `oauth` |
| MLD_OAUTH_CLIENT_ID | | OAuth client ID |
| MLD_OAUTH_CLIENT_SECRET | | OAuth client secret |
| MLD_OAUTH_ISSUER_URL | | OIDC issuer URL |
| MLD_OAUTH_REDIRECT_URI | | OAuth redirect URI |
| MLD_EXPECTED_USERNAME | | Expected username for user instance |
| MLD_INBOX_AGENT | | Set to `1` to enable inbox agent |
| DB_LOG_QUERIES | | Set to `1` to enable SQL query logging |
| DEBUG | | Debug module filter (optional) |

## API Routes

All API routes are defined in [backend/api/routes.go](backend/api/routes.go). Key endpoints:

| Group | Routes | Description |
|-------|--------|-------------|
| Auth | `/api/auth/*` | Login/logout |
| OAuth | `/api/oauth/*` | OAuth flow (authorize, callback, token, refresh, logout) |
| Inbox | `/api/inbox`, `/api/inbox/:id` | Inbox CRUD + pinning + re-enrichment + status |
| Library | `/api/library/*` | File management, tree structure, pinning, rename, move |
| Digest | `/api/digest/*` | Digester registry, stats, trigger/reset digests |
| People | `/api/people`, `/api/people/:id` | Person management + merge |
| Search | `/api/search` | Full-text search |
| AI | `/api/ai/summarize` | AI summarization |
| Settings | `/api/settings` | GET/PUT/POST (get, update, reset) |
| Stats | `/api/stats` | Application statistics |
| Upload | `/api/upload/tus/*`, `/api/upload/finalize` | TUS protocol file uploads + finalization |
| Directories | `/api/directories` | List available directories |
| Vendors | `/api/vendors/openai/models` | OpenAI model listing |
| Claude | `/api/claude/sessions/*` | Session CRUD, messages, WebSocket connections |
| ASR | `/api/asr`, `/api/asr/realtime` | Non-realtime ASR + real-time ASR WebSocket |
| Notifications | `/api/notifications/stream` | SSE event stream |
| Raw Files | `/raw/*path` | Serve (GET) / save (PUT) raw files |
| SQLAR | `/sqlar/*path` | Serve files from SQLAR archives |

## Major Feature Modules

### Claude Code Integration
The app embeds Claude Code sessions with a web UI for interacting with Claude CLI:
- **Backend** (`backend/claude/`): Session management, message parsing, WebSocket protocol for real-time communication, session index caching, file watching
- **Frontend** (`frontend/app/routes/claude.tsx`, `frontend/app/components/claude/`): Terminal UI, session list, chat interface, permission modal, todo panel
- **WebSocket routes**: `/api/claude/sessions/:id/ws` (bidirectional), `/api/claude/sessions/:id/subscribe` (read-only)
- **Docs**: See Claude Code section in `../my-life-db-docs/`

### Voice / ASR System
Real-time and batch speech recognition:
- **Backend**: `backend/api/realtime_asr.go` (WebSocket), `backend/vendors/aliyun.go` (Aliyun Fun-ASR)
- **Frontend**: `frontend/app/hooks/use-realtime-asr.ts`, `frontend/app/components/omni-input/` (multi-modal input: text, voice, files), recording visualizer, transcript viewer
- **Docs**: See Features section in `../my-life-db-docs/` (voice, realtime-asr, aliyun-asr-config, omni-input)

### Authentication
Three auth modes configured via `MLD_AUTH_MODE`:
- `none` — no authentication (default)
- `password` — simple password auth
- `oauth` — OIDC/OAuth 2.0 flow (see `backend/auth/`)

## Logging

The backend uses structured logging via zerolog:
- Info/Error/Debug logs go to stdout
- Includes Gin request logging middleware
- Logs are in JSON format in production, pretty-printed in development

**CRITICAL - Log Level Usage:**
- **ALWAYS use `log.Info()` for important debugging messages** - Debug level is often disabled in production
- Use `log.Debug()` only for verbose/noisy logs that should be filtered out
- Use `log.Error()` for actual errors
- **When adding temporary debug logging, use `log.Info()` so it's actually visible**

## Git Workflow

Do NOT create git commits automatically. Only commit when explicitly instructed.

**Always use git worktrees** for code changes — no exceptions, even for small changes. Never commit directly on `main`. **Create the worktree first, before making any code changes.** All edits happen inside the worktree directory.

**Never auto-commit or auto-push.** Wait for the user's explicit instruction to commit, merge, or push.

**Always rebase, never merge** — use `git rebase` + `git merge --ff-only` to keep a linear history. Never create merge commits.

    # 1. create worktree BEFORE making changes
    git worktree add -b <branch> .worktrees/<name> main
    # 2. commit — ONLY when user explicitly asks
    # 3. rebase & push — ONLY when user explicitly asks
    cd .worktrees/<name> && git rebase main
    git checkout main && git merge --ff-only <branch> && git push
    # 4. clean up — ONLY when user explicitly asks (or after merge)
    git worktree remove .worktrees/<name> && git branch -d <branch>

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
// User configured a port, but I "know" the service uses a different port
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

### Database Schema Changes (CRITICAL)

**Rule**: Changing columns/tables in queries → must update migrations. Changing query logic only → no migration needed.

**Migration-First Workflow**:
1. Update/create migration file
2. Update queries to match new schema
3. Test on fresh database: `rm -rf .my-life-db/ && go run .`

**Requires Migration**:
- Column/table/index names, types, constraints, primary keys

**No Migration Needed**:
- WHERE/JOIN/ORDER BY logic, LIMIT/OFFSET, query parameters

**Common Mistake**: Updating queries (e.g., `SELECT file_path FROM pins`) but forgetting to update migration that creates the table. Works on dev DB (already has column) but fails on fresh Docker setup.
