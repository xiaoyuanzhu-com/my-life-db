# Staging Environment Design

## Overview

Replace `run.sh` with `run.js` - a standalone Node.js script (zero local dependencies) that supports:
- All existing service commands (frontend, backend, meili, qdrant)
- New `--watch` flag for auto-restart on git changes
- New `github` command for real-time webhook-triggered git pull

## Usage

```bash
./run.js frontend           # Start frontend dev server
./run.js frontend --watch   # Start + auto-restart on git changes
./run.js backend            # Build and start backend
./run.js backend --watch    # Start + auto-restart on git changes
./run.js meili              # Start Meilisearch via Docker
./run.js qdrant             # Start Qdrant via Docker
./run.js github             # Connect to smee.io, auto-pull on push
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  run.js github                                              │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│  │  smee    │───▶│  webhook │───▶│ git pull │              │
│  │  client  │    │  handler │    │          │              │
│  └──────────┘    └──────────┘    └──────────┘              │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ files change on disk
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  run.js backend --watch        run.js frontend --watch     │
│  ┌──────────┐    ┌────────┐    ┌──────────┐    ┌────────┐  │
│  │  detect  │───▶│restart │    │  detect  │───▶│restart │  │
│  │  changes │    │if needed    │  changes │    │if needed  │
│  └──────────┘    └────────┘    └──────────┘    └────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Change Detection Logic (--watch)

1. Record current HEAD: `git rev-parse HEAD`
2. Start service process
3. Poll every 2 seconds: has HEAD changed?
4. If changed, get changed files: `git diff --name-only OLD_HEAD..NEW_HEAD`
5. Check if relevant paths changed:
   - `frontend --watch`: restarts if `frontend/**` changed
   - `backend --watch`: restarts if `backend/**` changed
6. Kill old process, restart service

## GitHub Command Flow

1. Start HTTP server on port 9999
2. Spawn: `smee -u https://smee.io/HgO0qrM4nNJLQv0 -t http://localhost:9999`
3. On POST /webhook:
   - Parse GitHub push payload
   - Run: `git fetch origin && git reset --hard origin/main`
   - Log changed files

## Dependencies

**None in project** - uses Node.js built-ins only:
- `node:child_process` - spawn processes
- `node:http` - webhook server
- `node:fs` - file operations, .env loading
- `node:path` - path handling

**Global prerequisites on staging machine:**
- Node.js (required for frontend build)
- Go (required for backend)
- Docker (required for meili/qdrant)
- `npm install -g smee-client`

## Configuration

Environment variables:
- `SMEE_URL` - Smee.io channel URL (required for `github` command, get one from https://smee.io)
- `USER_DATA_DIR` - User data directory (default: ./data)
- `APP_DATA_DIR` - App data directory (default: ./.my-life-db)
