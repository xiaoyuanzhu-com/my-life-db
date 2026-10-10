# MyLifeDB

> folders and files, that's it.

* app adapts to you, not the other way around.
* use your favorite apps, at the same time.
* zero vendor lock-in.

## Tech Stack

- **Backend**: Go 1.25 + Gin + SQLite
- **Frontend**: React Router 7 (SPA) + React 19 + TypeScript + Tailwind CSS 4 + Vite
- **Search**: filename/path search over SQLite metadata; FTS5 for session transcripts
- **AI**: OpenAI (summarization, tagging), HAID (OCR, ASR, crawling), Aliyun (real-time ASR)
- **Real-time**: SSE notifications + WebSocket (Claude Code, ASR)

## Getting Started

### Docker (Recommended)

```bash
mkdir -p data app-data

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
    stop_grace_period: 11m
    environment:
      - USER_DATA_DIR=/home/xiaoyuanzhu/my-life-db/data
      - APP_DATA_DIR=/home/xiaoyuanzhu/my-life-db/.my-life-db
EOF

docker-compose up -d
```

Visit [http://localhost:12345](http://localhost:12345).

The container runs as UID/GID 1000. If you have permission issues: `sudo chown -R 1000:1000 ./data ./app-data`

### Local Development

```bash
# Frontend
cd frontend && npm install && npm run build

# Backend (serves frontend + API)
cd backend && go run .
```

Or use the helper script:

```bash
./run.js frontend --watch   # Frontend dev with auto-restart
./run.js backend --watch    # Backend dev with auto-restart
```

## Data Ownership

Your files live in `USER_DATA_DIR/` — the filesystem is the source of truth.
`APP_DATA_DIR/` also contains persistent settings, pins, and session state in
`app.sqlite` and transcript files, alongside rebuildable indexes and caches.
Do not delete the entire app-data directory to reclaim cache space.

## Documentation

Full documentation: [`my-life-db-docs/`](../my-life-db-docs/) (Astro Starlight site)

## License

MIT

## Lightweight File Search And Previews

File search matches names/paths, not file bodies. There is no startup file-text
backfill or content indexing on changes. Session transcript search stays on FTS5.
Build directories (`target`, `build`, `dist`, `out`) are excluded from metadata
scans/watching, but remain accessible in the filesystem browser and via direct
file operations.

Thumbnails are generated only when requested by a visible card or file view.
They are cached outside SQLite under `APP_DATA_DIR/previews`, with a 256 MiB
per-instance limit and oldest-accessed eviction. No full-library preview jobs
run. Inputs above 64 MiB or images above 40 million pixels fall back to file icons.

Migration 039 removes file-content FTS and generated SQLAR previews only. It
preserves file metadata, non-preview SQLAR entries, session search, `app.sqlite`,
and all user files. Deploying this schema is **not compatible with rolling back
to the old file-FTS binary**; back up the databases before upgrading.

### Reclaim Existing Index Space

Stop the instance and all other processes that access its databases, then run
**the new binary** with its normal environment:

```sh
./backend/my-life-db --compact-index
```

This maintenance mode requires an existing `index.sqlite`, acquires exclusive
SQLite ownership before migrating, applies the index migrations, checkpoints
and truncates the WAL, and runs `VACUUM` to shrink the database file. It does not
start the HTTP server, scanners, or agents. Leave temporary free disk space for
SQLite compaction, keep a verified pre-upgrade backup, and restart the instance
only after the command succeeds. Never delete a WAL manually.
