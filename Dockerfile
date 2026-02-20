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

# Stage 2: Build Go server
FROM golang:1.25-alpine AS go-builder
WORKDIR /app

# Install build dependencies for CGO (SQLite)
RUN apk add --no-cache gcc musl-dev

# Copy go files
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Copy Go source
COPY backend/ ./

# Build with CGO enabled for SQLite
ENV CGO_ENABLED=1
RUN go build -o my-life-db .

# Stage 3: Production image
FROM debian:trixie AS runner
WORKDIR /home/xiaoyuanzhu/my-life-db

# Install runtime dependencies + Claude CLI dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates tzdata curl bash git openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user with UID/GID 1000 for better host compatibility
RUN groupadd -g 1000 xiaoyuanzhu && useradd -u 1000 -g xiaoyuanzhu -m xiaoyuanzhu

# Copy built artifacts maintaining local structure
COPY --from=go-builder /app/my-life-db ./backend/my-life-db
COPY --from=frontend-builder /app/dist ./frontend/dist

# Create data directories and .claude directory with proper permissions
RUN mkdir -p /home/xiaoyuanzhu/my-life-db/data \
             /home/xiaoyuanzhu/my-life-db/.my-life-db \
             /home/xiaoyuanzhu/.claude && \
    chown -R 1000:1000 /home/xiaoyuanzhu && \
    chmod -R 775 /home/xiaoyuanzhu/my-life-db/data \
                 /home/xiaoyuanzhu/my-life-db/.my-life-db \
                 /home/xiaoyuanzhu/.claude

# Switch to non-root user
USER 1000

# Install Claude CLI as xiaoyuanzhu user
# The installer will put it in ~/.local/bin/claude
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add ~/.local/bin to PATH for the xiaoyuanzhu user
ENV PATH="/home/xiaoyuanzhu/.local/bin:${PATH}"

# Environment variables
ENV NODE_ENV=production
ENV PORT=12345
ENV HOST=0.0.0.0
ENV USER_DATA_DIR=/home/xiaoyuanzhu/my-life-db/data
ENV APP_DATA_DIR=/home/xiaoyuanzhu/my-life-db/.my-life-db
ENV HOME=/home/xiaoyuanzhu

EXPOSE 12345

CMD ["./backend/my-life-db"]
