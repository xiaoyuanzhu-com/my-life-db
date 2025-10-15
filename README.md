# MyLifeDB MVP

A filesystem-based personal knowledge management system built with Next.js 15, React 19, and TypeScript.

## Features

### MVP (Currently Implemented)

- ✅ **Text Capture**: Quick-add text entries with auto-save
- ✅ **Directory-Based Organization**: Organize entries into filesystem directories
- ✅ **Inbox**: Capture thoughts without upfront organization
- ✅ **Library**: Browse and manage organized directories
- ✅ **Full-Text Search**: Search across all entries
- ✅ **Markdown Storage**: All entries stored as markdown files
- ✅ **Filesystem-First**: No database required, pure file-based storage

### Coming Soon

- ⏭️ AI Tagging with OpenAI
- ⏭️ Voice/File Upload
- ⏭️ Export to ZIP
- ⏭️ Entry Filing (move entries between directories)
- ⏭️ Advanced Search with Filters

## Tech Stack

- **Framework**: Next.js 15.5.5 with App Router
- **UI**: React 19, Tailwind CSS 4
- **Language**: TypeScript 5.7+
- **Data**: Filesystem-based (Markdown + JSON)
- **Validation**: Zod
- **State**: React Hooks
- **Date Handling**: date-fns

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000) to see the app.

### First Steps

1. **Capture your first entry**: Use the Quick Capture form on the homepage
2. **View your Inbox**: Click "Inbox" in the navigation to see all captured entries
3. **Create a directory**: Go to "Library" and click "New Directory"
4. **Organize**: Move entries from Inbox to your directories (coming soon)

## File Storage

All entries are stored as Markdown files with frontmatter metadata. See documentation for details.

## Data Ownership

All your data is stored locally in the `data/` directory as human-readable Markdown and JSON files. You can:

- ✅ Directly edit files in any text editor
- ✅ Backup by copying the `data/` directory
- ✅ Version control with Git (data directory is gitignored)
- ✅ Export and migrate without vendor lock-in

## Documentation

- [Product Design Document](./docs/product-design.md)
- [Technical Design Document](./docs/tech-design.md)
- [MVP Implementation Guide](./docs/mvp.md)

## License

MIT
