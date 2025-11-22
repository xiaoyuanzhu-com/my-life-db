# Base stage - install dependencies
FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Dependencies stage
FROM base AS deps
RUN npm ci

# Builder stage - build the application
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build with Turbopack
RUN npm run build

# Runner stage - production image
FROM node:20-alpine AS runner
WORKDIR /app

# Install runtime dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Copy necessary files from builder
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Create data directory owned by app user; group-writable for default UID/GID
RUN mkdir -p /app/data && chown node:node /app/data && chmod 775 /app/data

# Use built-in non-root node user (uid/gid 1000) from the base image to avoid gid conflicts
USER node

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENV MY_DATA_DIR=/app/data

CMD ["node", "server.js"]
