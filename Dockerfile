# Multi-stage build for Go server with React frontend
# Stage 1: Build frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app

# Install dependencies
COPY frontend/package*.json ./
RUN npm ci

# Copy source and build
COPY frontend/ .
RUN npm run build

# Stage 2: Build Go server + libsimple SQLite FTS5 extension
FROM golang:1.25 AS go-builder
WORKDIR /app

# Install build dependencies: CGO (SQLite) + cmake/g++ (libsimple) + git (cppjieba download)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libc6-dev cmake git \
    && rm -rf /var/lib/apt/lists/*

# Copy go files
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Copy Go source (includes backend/third_party/simple submodule snapshot)
COPY backend/ ./

# Build libsimple.so + jieba dict files into a staging tree mirroring the
# runtime extensions/ layout. The runtime image copies this whole tree.
#
# cmake flags:
#   -DBUILD_SQLITE3=OFF      — skip contrib sqlite3 (go-sqlite3 provides FTS5)
#   -DBUILD_TEST_EXAMPLE=OFF — skip test/example binaries
#   cppjieba is downloaded via ExternalProject_Add (needs git + network);
#   its dict/ is copied to build/test/dict/ by a PRE_BUILD step.
RUN bash -c 'set -e; \
    cd third_party/simple && mkdir -p build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_SQLITE3=OFF -DBUILD_TEST_EXAMPLE=OFF .. && \
    make -j"$(nproc)" && \
    mkdir -p /app/extensions/dict && \
    cp src/libsimple.so /app/extensions/libsimple.so && \
    for f in jieba.dict.utf8 hmm_model.utf8 user.dict.utf8 idf.utf8 stop_words.utf8; do \
      cp test/dict/$f /app/extensions/dict/$f; \
    done'

# Build with CGO enabled for SQLite + sqlite_fts5 build tag (required by libsimple)
ENV CGO_ENABLED=1
RUN go build -tags sqlite_fts5 -o my-life-db .

# Stage 3: Production image
#
# Layer ordering principle: every install that does NOT depend on app code
# happens BEFORE the COPY commands. App-only changes (Go binary, frontend
# bundle, libsimple) only invalidate the final COPY layers (~85MB), instead
# of re-pulling chromium + claude + nodejs + npm globals (~600MB) every push.
FROM debian:trixie AS runner
WORKDIR /home/xiaoyuanzhu/my-life-db

# Stable system packages: runtime deps + Python toolchain (for screenitshot
# / playwright) + Node.js + npm (for the ACP agent ecosystem). Combined into
# ONE apt-get to avoid duplicate index downloads and an extra layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tzdata curl bash git openssh-client \
    python3 python3-pip python3-venv python3-dev gcc \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# screenitshot for document preview generation (PDF, EPUB, DOCX, etc.) +
# Chromium's system-level dependencies (pulled in by playwright install-deps).
RUN pip3 install --break-system-packages "screenitshot>=0.7.2" && \
    playwright install-deps chromium

# ACP agent binaries (installed as root for global npm path).
#   - @zed-industries/claude-agent-acp → `claude-agent-acp` (Claude Code ACP wrapper)
#   - @zed-industries/codex-acp        → `codex-acp`        (OpenAI Codex ACP wrapper)
#   - @google/gemini-cli               → `gemini`           (runs ACP via `gemini --acp`)
#   - @qwen-code/qwen-code             → `qwen`             (runs ACP via `qwen --acp`)
#   - opencode-ai                      → `opencode`         (runs ACP via `opencode acp`)
RUN npm install -g \
    @zed-industries/claude-agent-acp \
    @zed-industries/codex-acp \
    @google/gemini-cli \
    @qwen-code/qwen-code \
    opencode-ai

# Create non-root user with UID/GID 1000 for better host compatibility.
RUN groupadd -g 1000 xiaoyuanzhu && useradd -u 1000 -g xiaoyuanzhu -m xiaoyuanzhu

# Create data directories and .claude directory with proper permissions.
RUN mkdir -p /home/xiaoyuanzhu/my-life-db/data \
             /home/xiaoyuanzhu/my-life-db/.my-life-db \
             /home/xiaoyuanzhu/.claude && \
    chown -R 1000:1000 /home/xiaoyuanzhu && \
    chmod -R 775 /home/xiaoyuanzhu/my-life-db/data \
                 /home/xiaoyuanzhu/my-life-db/.my-life-db \
                 /home/xiaoyuanzhu/.claude

# Set HOME explicitly before per-user installs so caches land under
# /home/xiaoyuanzhu/ rather than /root/. Docker does NOT auto-set HOME from
# /etc/passwd when USER changes — it inherits whatever was last in ENV.
ENV HOME=/home/xiaoyuanzhu
ENV PATH="/home/xiaoyuanzhu/.local/bin:${PATH}"

USER 1000

# Per-user installs: Chromium browser (~/.cache/ms-playwright) + Claude CLI
# (~/.local/bin/claude). Both write under HOME, so they need USER 1000.
RUN playwright install chromium
RUN curl -fsSL https://claude.ai/install.sh | bash

# Runtime environment.
ENV NODE_ENV=production
ENV PORT=12345
ENV HOST=0.0.0.0
ENV USER_DATA_DIR=/home/xiaoyuanzhu/my-life-db/data
ENV APP_DATA_DIR=/home/xiaoyuanzhu/my-life-db/.my-life-db
ENV MLD_SIMPLE_EXTENSION_DIR=/opt/mld/extensions

# Application artifacts — kept LAST so app-code changes invalidate ONLY these
# layers (~85MB), not any of the heavy install layers above.
# libsimple ships at /opt/mld/extensions (NOT under .my-life-db, which is a
# bind-mount target at runtime — anything there would be shadowed).
COPY --from=go-builder       --chown=1000:1000 /app/my-life-db ./backend/my-life-db
COPY --from=go-builder       --chown=1000:1000 /app/extensions /opt/mld/extensions
COPY --from=frontend-builder --chown=1000:1000 /app/dist       ./frontend/dist

EXPOSE 12345

CMD ["./backend/my-life-db"]
