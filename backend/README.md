# MyLifeDB Backend

This is the Go backend for MyLifeDB.

## Overview

The Go server provides:
- All API endpoints (35+ routes)
- Static file serving for the React frontend
- SSE notifications
- TUS resumable uploads
- Background workers (file watcher, digest processor)

## Requirements

- Go 1.23+
- CGO enabled (for SQLite)
- Node.js 20+ (for building frontend)

## Project Structure

```
backend/
├── main.go               # Entry point
├── api/                  # HTTP handlers
│   ├── auth.go
│   ├── inbox.go
│   ├── search.go
│   └── ...
├── db/                   # Database layer
│   ├── connection.go
│   ├── client.go
│   ├── files.go
│   └── ...
├── workers/              # Background workers
│   ├── fs/               # File system watcher
│   └── digest/           # Digest processor
├── vendors/              # External service clients
│   ├── meilisearch.go
│   ├── qdrant.go
│   ├── openai.go
│   └── haid.go
├── notifications/        # SSE service
├── config/               # Configuration
├── log/                  # Logging
├── go.mod
├── go.sum
└── Makefile
```

## Building

### Build Frontend + Server

```bash
cd backend
make build
```

This will:
1. Build the React frontend to `dist/client/`
2. Build the Go server to `bin/server`

### Build Server Only

```bash
cd backend
make build-server
# Or: go build -o ../bin/server .
```

### Build Frontend Only

```bash
cd frontend
npm run build:client
```

## Running

### Development

```bash
# Run Go server directly (requires frontend to be built)
cd backend
make dev
# Or: go run .
```

### Production

```bash
cd backend
make build
../bin/server
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 12345 | Server port |
| HOST | 0.0.0.0 | Server host |
| NODE_ENV | development | Environment (production/development) |
| MY_DATA_DIR | ./data | Data directory |
| MEILI_HOST | | Meilisearch host URL |
| MEILI_API_KEY | | Meilisearch API key |
| MEILI_INDEX | files | Meilisearch index name |
| QDRANT_HOST | | Qdrant host URL |
| QDRANT_COLLECTION | files | Qdrant collection name |
| OPENAI_API_KEY | | OpenAI API key |
| OPENAI_BASE_URL | https://api.openai.com/v1 | OpenAI base URL |
| OPENAI_MODEL | gpt-4o-mini | Default model |
| HAID_BASE_URL | | HAID service URL |
| DB_LOG_QUERIES | | Set to "1" to log queries |
| DEBUG | | Comma-separated module names for debug logging |

## API Endpoints

The Go server implements all the same API endpoints as the Node.js server:

- **Auth**: `/api/auth/login`, `/api/auth/logout`
- **OAuth**: `/api/oauth/*`
- **Inbox**: `/api/inbox`, `/api/inbox/:id`, `/api/inbox/pinned`
- **Digest**: `/api/digest/*`
- **Library**: `/api/library/*`
- **Search**: `/api/search`
- **People**: `/api/people/*`
- **Settings**: `/api/settings`
- **Stats**: `/api/stats`
- **Upload**: `/api/upload/tus/*`, `/api/upload/finalize`
- **Raw Files**: `/raw/*`
- **SQLAR Files**: `/sqlar/*`
- **Notifications**: `/api/notifications/stream` (SSE)

## Database

The Go server uses the same SQLite database as the Node.js server. The database
is automatically created at `MY_DATA_DIR/.my-life-db/database.sqlite`.

Migrations are handled by the Node.js server. The Go server includes a baseline
migration that creates tables if they don't exist.

## Development

### Running Tests

```bash
cd backend
make test
```

### Linting

```bash
cd backend
make lint
```

### Debug Logging

Enable debug logging for specific modules:

```bash
DEBUG=VendorOpenAI,DigestWorker ./bin/server
```

## License

MIT
