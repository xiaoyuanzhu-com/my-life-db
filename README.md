# MyLifeDB

> folders and files, that's it.

* app adapts to you, not the other way around.
* use your favorite apps, at the same time.
* zero vendor lock-in.

## Tech Stack

- **Backend**: Go 1.25 + Gin + SQLite
- **Frontend**: React Router 7 (SPA) + React 19 + TypeScript + Tailwind CSS 4 + Vite
- **Search**: Meilisearch (full-text)
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

Your data lives in `USER_DATA_DIR/` as plain files — the filesystem is the source of truth. `APP_DATA_DIR/` contains only rebuildable metadata (SQLite). Delete it anytime; it rebuilds from your files.

## Documentation

Full documentation: [`my-life-db-docs/`](../my-life-db-docs/) (Astro Starlight site)

## License

MIT
