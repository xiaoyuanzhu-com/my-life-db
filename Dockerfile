# Base stage - install dependencies
FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Copy package files
COPY frontend/package*.json ./

# Dependencies stage
FROM base AS deps
RUN npm ci

# Builder stage - build the application
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY frontend/ .

RUN npm run build

# Runner stage - production image
FROM node:20-alpine AS runner
WORKDIR /app

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

ENV NODE_ENV=production

# Copy build output and dependencies
COPY --from=builder /app/build ./build
COPY --from=builder /app/static ./static
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/server.js ./

# Create data directory owned by app user; group-writable for default UID/GID
RUN mkdir -p /app/data && chown node:node /app/data && chmod 775 /app/data

# Use built-in non-root node user (uid/gid 1000) from the base image to avoid gid conflicts
USER node

EXPOSE 12345

ENV PORT=12345
ENV HOSTNAME="0.0.0.0"
ENV MY_DATA_DIR=/app/data

CMD ["node", "server.js"]
