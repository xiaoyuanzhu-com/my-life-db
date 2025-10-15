# MVP Implementation Guide: MyLifeDB

**Version:** 1.0
**Last Updated:** 2025-10-15
**Owner:** Engineering Team

---

## Table of Contents

1. [MVP Goals](#1-mvp-goals)
2. [Pages & Routes](#2-pages--routes)
3. [Features Implementation](#3-features-implementation)
4. [Data Models](#4-data-models)
5. [Common Patterns](#5-common-patterns)

---

## 1. MVP Goals

**Prove Core Value:** Users can capture thoughts effortlessly and organize them with AI assistance.

**What's In:**
- ✅ Text capture with quick-add
- ✅ Auto-save
- ✅ AI tagging (2-3 tags per entry)
- ✅ Manual Space creation
- ✅ Entry-Space linking
- ✅ Full-text search
- ✅ Export to Markdown
- ✅ Local SQLite storage

**What's Out:**
- ⏭️ Voice/file upload
- ⏭️ AI clustering
- ⏭️ Insights & Principles
- ⏭️ Weekly digest
- ⏭️ Integrations

---

## 2. Pages & Routes

### 2.1 Main Application Pages
- `/` - Homepage (default landing) - combined input, quick insights, and search
- `/inbox` - Full Inbox view
- `/library` - Library overview
- `/library/[spaceId]` - Space detail view
- `/search` - Advanced search results page

### 2.2 Settings
- `/settings` - User settings (AI config, export)

---

## 3. Features Implementation

### 3.1 Homepage
- Quick-add input (prominent)
- Global search bar
- Quick insights panel (recent entries count, suggested Spaces)
- Recent entries preview (last 5-10)
- Quick access to Spaces

### 3.2 Inbox (Entry Capture)
- Quick-add bar (always visible)
- Entry list view
- Entry card component
- Create entry (text only)
- Edit entry
- Delete entry
- Auto-save functionality
- Entry metadata (timestamp, tags)

### 3.3 AI Tagging
- OpenAI integration
- Generate 2-3 tags per entry
- Tag suggestions UI
- Accept/reject tag suggestions
- Confidence display

### 3.4 Library (Spaces)
- Space sidebar navigation
- Create Space (manual)
- Edit Space (title, description, cover)
- Delete Space
- Archive Space
- Space detail view
- Space card component

### 3.5 Entry-Space Linking
- Link entry to Space(s)
- Unlink entry from Space
- View entries in Space
- Many-to-many relationship

### 3.6 Search
- Global search bar (⌘K shortcut)
- Full-text search (SQLite FTS5)
- Filter by date range
- Filter by Space
- Search results list
- Result highlighting

### 3.7 Export
- Export single Space to Markdown
- Export all data (JSON + Markdown)
- Download as ZIP file

### 3.8 UI Components
- Quick-add input
- Entry card
- Space card
- Search bar
- Filter panel
- Modal dialogs
- Toast notifications
- Loading states

---

## 4. Data Models

### 4.1 Database Schema
### 4.2 TypeScript Types
### 4.3 API Contracts

---

## 5. Common Patterns

### 5.1 Server Actions
### 5.2 Database Queries
### 5.3 Error Handling
### 5.4 Loading States

---

**For complete requirements:** [product-design.md](./product-design.md)
**For technical architecture:** [tech-design.md](./tech-design.md)
