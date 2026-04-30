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

# Install build dependencies: CGO (SQLite) + cmake/g++ (libsimple)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libc6-dev cmake \
    && rm -rf /var/lib/apt/lists/*

# Copy go files
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Copy Go source (includes backend/third_party/simple submodule snapshot)
COPY backend/ ./

# Build libsimple.so + jieba dict files into a staging tree mirroring the
# runtime extensions/ layout. The runtime image copies this whole tree.
RUN bash -c 'set -e; \
    cd third_party/simple && mkdir -p build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_TEST_EXAMPLE=OFF .. && \
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
FROM debian:trixie AS runner
WORKDIR /home/xiaoyuanzhu/my-life-db

# Install runtime dependencies + Claude CLI dependencies + Python runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tzdata curl bash git openssh-client \
    python3 python3-pip python3-venv python3-dev gcc \
    && rm -rf /var/lib/apt/lists/*

# Install screenitshot for document preview generation (PDF, EPUB, DOCX, etc.)
# Step 1 (as root): install pip package + Chromium's system-level dependencies
RUN pip3 install --break-system-packages "screenitshot>=0.7.2" && \
    playwright install-deps chromium

# Create non-root user with UID/GID 1000 for better host compatibility
RUN groupadd -g 1000 xiaoyuanzhu && useradd -u 1000 -g xiaoyuanzhu -m xiaoyuanzhu

# Create data directories and .claude directory with proper permissions
# Done BEFORE COPY so chown only touches empty dirs, not the binaries
RUN mkdir -p /home/xiaoyuanzhu/my-life-db/data \
             /home/xiaoyuanzhu/my-life-db/.my-life-db \
             /home/xiaoyuanzhu/.claude && \
    chown -R 1000:1000 /home/xiaoyuanzhu && \
    chmod -R 775 /home/xiaoyuanzhu/my-life-db/data \
                 /home/xiaoyuanzhu/my-life-db/.my-life-db \
                 /home/xiaoyuanzhu/.claude

# Copy built artifacts with correct ownership (avoids extra chown layer).
# libsimple ships at /opt/mld/extensions (NOT under .my-life-db, which is a
# bind-mount target at runtime — anything there would be shadowed).
COPY --from=go-builder --chown=1000:1000 /app/my-life-db ./backend/my-life-db
COPY --from=go-builder --chown=1000:1000 /app/extensions /opt/mld/extensions
COPY --from=frontend-builder --chown=1000:1000 /app/dist ./frontend/dist

# Switch to non-root user
USER 1000

# Step 2 (as xiaoyuanzhu): download Chromium browser to user's cache
RUN playwright install chromium

# Install Claude CLI as xiaoyuanzhu user
# The installer will put it in ~/.local/bin/claude
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add ~/.local/bin to PATH for the xiaoyuanzhu user
ENV PATH="/home/xiaoyuanzhu/.local/bin:${PATH}"

# Node.js runtime (required for ACP agent ecosystem)
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm && rm -rf /var/lib/apt/lists/*

# ACP agent binaries (must install as root for global npm path)
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

USER 1000

# Environment variables
ENV NODE_ENV=production
ENV PORT=12345
ENV HOST=0.0.0.0
ENV USER_DATA_DIR=/home/xiaoyuanzhu/my-life-db/data
ENV APP_DATA_DIR=/home/xiaoyuanzhu/my-life-db/.my-life-db
ENV MLD_SIMPLE_EXTENSION_DIR=/opt/mld/extensions
ENV HOME=/home/xiaoyuanzhu

EXPOSE 12345

CMD ["./backend/my-life-db"]
