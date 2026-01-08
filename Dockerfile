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
RUN go build -o /app/bin/server .

# Stage 3: Production image
FROM alpine:3.20 AS runner
WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache ca-certificates tzdata

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy built artifacts
COPY --from=go-builder /app/bin/server ./server
COPY --from=frontend-builder /app/dist ./frontend/dist

# Create data directory
RUN mkdir -p /app/data && chown -R appuser:appgroup /app/data

# Switch to non-root user
USER appuser

# Environment variables
ENV NODE_ENV=production
ENV PORT=12345
ENV HOST=0.0.0.0
ENV MY_DATA_DIR=/app/data

EXPOSE 12345

CMD ["./server"]
