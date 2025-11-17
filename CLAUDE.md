# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Next.js 15.5.5 application with TypeScript, React 19, and Tailwind CSS 4. It uses the App Router architecture (not Pages Router).

## Common Commands

### Development
- `npm run dev` - Start development server with Turbopack (runs on http://localhost:3000)
- `npm run build` - Build production application with Turbopack
- `npm start` - Start production server (must run `npm run build` first)
- `npm run lint` - Run ESLint to check code quality

### Important Build Details
- This project uses **Turbopack** as the bundler (specified in build and dev scripts)
- TypeScript strict mode is enabled
- ESLint uses Next.js config with `next/core-web-vitals` and `next/typescript` presets

## Architecture

### Data Storage Structure

The application uses a flat, user-friendly data structure with two special folders:

```
MY_DATA_DIR/
├── inbox/              # Unprocessed items (source of truth)
│   ├── photo.jpg       # Single file items
│   └── {uuid}/         # Multi-file items (renamed to slug after digest)
│       ├── text.md
│       └── files...
├── notes/              # User library folders (source of truth)
├── journal/            # User library folders (source of truth)
├── work/               # User library folders (source of truth)
└── app/                # Application data (rebuildable)
    └── mylifedb/
        └── database.sqlite
```

**Design Principles:**
1. **inbox** and user folders (notes, journal, etc.) are the **source of truth** - plain files on disk
2. **app/** folder contains rebuildable data - can be deleted and rebuilt from source files
3. **Reserved folders**: `inbox`, `app` (all others are user library content)
4. MyLifeDB is not the only app managing the data - other apps can read/write files
5. Users can delete the app folder and rebuild search indexes, crawl results, etc.

### Database (SQLite)

- **Location**: `MY_DATA_DIR/app/mylifedb/database.sqlite`
- **`MY_DATA_DIR`** environment variable sets the base data directory (defaults to `./data`)
- Uses `better-sqlite3` for synchronous database operations
- Database is automatically created and initialized on first use

**Core Tables:**

1. **files** - Rebuildable cache of file metadata
   - Tracks all files and folders in DATA_ROOT for fast queries
   - Primary key: relative path from DATA_ROOT (e.g., 'inbox/photo.jpg', 'inbox/uuid-folder')
   - Stores: name, size, MIME type, SHA256 hash (for <10MB files), timestamps
   - Can be deleted and rebuilt from filesystem at any time
   - Updated by library scanner on schedule

2. **digests** - AI-generated content (rebuildable)
   - Summary, tags, slug, screenshots, crawled content, etc.
   - References files by path (file_path field)
   - Text content stored in `content` field
   - Binary content stored in SQLAR (see below)
   - Status field: 'pending', 'enriching', 'enriched', 'failed'
   - Overall enrichment status derived from digest statuses

3. **sqlar** - SQLite Archive format for binary digests
   - Stores compressed screenshots, processed HTML, etc.
   - Standard SQLite format with zlib compression
   - Files named using path hash: `{path_hash}/{digest_type}/filename`

4. **tasks** - Background job queue
5. **settings** - Application configuration
6. **search_documents** - Chunked content for search (TO BE UPDATED)

### Library Scanner

- Automatically scans `MY_DATA_DIR` every 1 hour for new/changed files
- Updates files table cache for all non-reserved folders (inbox/, app/ are skipped)
- Hashes small files (< 10MB) for change detection
- Stores file metadata: path, name, size, MIME type, hash, timestamps
- Runs on app startup (after 10 seconds) and periodically
- Files table is purely a cache - can be deleted and rebuilt

### File-Centric Architecture

**No "Items" Abstraction:**
- Files are the primary abstraction - referenced by relative paths
- No synthetic item IDs or items table
- Digests reference files by path (e.g., 'inbox/photo.jpg', 'inbox/uuid-folder')
- Status derived from digest table, not stored separately
- Maximum simplicity and durability - works with any file browser

**Inbox Handling:**
- Single file: saved as `inbox/{unique-filename}` (no folder)
- Multiple files or text+files: saved as `inbox/{uuid}/` folder
- UUID folders renamed to friendly slug after digest generation
- Slug generation only for UUID-named files/folders (not user-uploaded names)

**Digest Workflow:**
- Each file path can have multiple digest types (summary, tags, slug, screenshot, content-md)
- Digests created on-demand via `/api/inbox/{id}/digest` endpoint
- Status tracked in digest.status field: pending → enriching → enriched (or failed)
- Digest IDs generated from file path hash + digest type for stability

### App Router Structure
- Uses Next.js App Router located in `src/app/`
- Root layout in `src/app/layout.tsx` handles:
  - Font loading (system fonts used in constrained build environments)
  - Global CSS imports
  - HTML structure with font CSS variables
- Main page is `src/app/page.tsx`

### Styling
- Tailwind CSS 4 with PostCSS plugin (`@tailwindcss/postcss`)
- Global styles in `src/app/globals.css` with:
  - CSS custom properties for theming (`--background`, `--foreground`)
  - Automatic dark mode via `prefers-color-scheme`
  - Tailwind theme inline configuration with font variables
- Geist font family used via CSS variables (`--font-geist-sans`, `--font-geist-mono`)

### UI Components (shadcn/ui)
**IMPORTANT:** This project uses shadcn/ui components. Follow these rules:

1. **Adding New Components**:
   - ALWAYS use the official shadcn CLI: `npx shadcn@latest add <component-name>`
   - Example: `npx shadcn@latest add tabs`
   - NEVER create shadcn components manually

2. **Available Components**: Check https://ui.shadcn.com/docs/components for available components

3. **Why Use CLI**:
   - Automatically installs required dependencies (e.g., @radix-ui packages)
   - Ensures correct component structure and styling
   - Maintains consistency with project configuration

### TypeScript Configuration
- Path alias: `@/*` maps to `./src/*`
- Module resolution: bundler
- Strict mode enabled
- Target: ES2017

### ESLint Configuration
- Uses flat config format (eslint.config.mjs)
- Ignores: `node_modules`, `.next`, `out`, `build`, `next-env.d.ts`

## Naming Conventions

| Category | Convention | Examples |
|----------|-----------|----------|
| **Files** | `kebab-case.ts/tsx` | `file-card.tsx`, `url-crawler.ts`, `layout.tsx` |
| **Types/Interfaces** | `PascalCase` | `FileRecord`, `Digest`, `MessageType` |
| **Functions/Variables** | `camelCase` | `getFileByPath()`, `filePath`, `itemId` |
| **Constants** | `SCREAMING_SNAKE_CASE` | `DATA_ROOT`, `INBOX_DIR` |
| **DB columns** | `snake_case` | `file_path`, `created_at` |

### Type System Organization

**Directory Structure:**
```
src/types/
├── models/                     # Core database models
│   ├── enums/                 # kebab-case.ts files
│   │   ├── message-type.ts
│   │   ├── enrichment-status.ts
│   │   └── digest-type.ts
│   ├── database/              # kebab-case.ts files
│   │   ├── file-record.ts     # Contains: FileRecordRow, FileRecord, rowToFileRecord
│   │   ├── digest.ts
│   │   └── task.ts
│   └── index.ts               # Aggregates exports
├── models.ts                   # Re-exports from models/
├── file-card.ts                # UI-specific types
├── digest-workflow.ts          # Workflow types
└── index.ts                    # Main entry point
```

## Development Server

**IMPORTANT:** Do NOT run `npm run dev` in the terminal. The user already has a development server running. Assume the server is always running at http://localhost:3000.

## Git Workflow

**IMPORTANT:** Do NOT create git commits automatically. Only commit when explicitly instructed by the user with commands like "commit it" or "commit this".

## Design Preferences

- **Minimal Borders**: Avoid using too many dividers and borders in the UI. Keep the design clean and minimal.
