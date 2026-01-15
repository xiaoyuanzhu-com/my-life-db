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
FROM alpine:3.20 AS runner
WORKDIR /home/xiaoyuanzhu/my-life-db

# Install runtime dependencies + Claude CLI dependencies
# libstdc++ and libgcc are required for Claude CLI (C++ runtime)
RUN apk add --no-cache ca-certificates tzdata curl bash libstdc++ libgcc

# Install Claude CLI globally (before switching to non-root user)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Create non-root user with UID/GID 1000 for better host compatibility
RUN addgroup -g 1000 xiaoyuanzhu && adduser -u 1000 -G xiaoyuanzhu -S xiaoyuanzhu

# Copy built artifacts maintaining local structure
COPY --from=go-builder /app/my-life-db ./backend/my-life-db
COPY --from=frontend-builder /app/dist ./frontend/dist

# Create data directory and .claude directory with proper permissions
RUN mkdir -p /home/xiaoyuanzhu/my-life-db/data /home/xiaoyuanzhu/.claude && \
    chown -R 1000:1000 /home/xiaoyuanzhu && \
    chmod -R 775 /home/xiaoyuanzhu/my-life-db/data /home/xiaoyuanzhu/.claude

# Switch to non-root user
USER 1000

# Environment variables
ENV NODE_ENV=production
ENV PORT=12345
ENV HOST=0.0.0.0
ENV MY_DATA_DIR=/home/xiaoyuanzhu/my-life-db/data
ENV HOME=/home/xiaoyuanzhu

EXPOSE 12345

CMD ["./backend/my-life-db"]
