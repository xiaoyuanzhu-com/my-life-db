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
- ✅ Directory-based organization
- ✅ Entry filing to directories
- ✅ Full-text search
- ✅ Export to Markdown
- ✅ Filesystem storage

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
- `/library` - Library overview (directory browser)
- `/library/[dirPath]` - Directory detail view
- `/search` - Advanced search results page

### 2.2 Settings
- `/settings` - User settings (AI config, export)

---

## 3. Features Implementation

### 3.1 Homepage
- Quick-add input (prominent)
- Global search bar
- Quick insights panel (recent entries count, suggested directories)
- Recent entries preview (last 5-10)
- Quick access to directories

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

### 3.4 Library (Directory Browser)
- Directory tree navigation
- Create directory
- Rename directory
- Delete directory
- Archive directory
- Directory detail view
- Directory card component

### 3.5 Entry Filing
- Move entry to directory
- Copy entry to multiple directories
- View entries in directory
- Filesystem-based organization

### 3.6 Search
- Global search bar (⌘K shortcut)
- Full-text search across all files
- Filter by date range
- Filter by directory
- Search results list
- Result highlighting

### 3.7 Export
- Export single directory to ZIP
- Export all data (native filesystem copy)
- Already in Markdown format

### 3.8 UI Components
- Quick-add input
- Entry card
- Directory card
- Search bar
- Filter panel
- Modal dialogs
- Toast notifications
- Loading states

---

## 4. Data Models

### 4.1 Filesystem Structure
### 4.2 TypeScript Types
### 4.3 File Formats

---

## 5. Common Patterns

### 5.1 File Operations
### 5.2 Directory Navigation
### 5.3 Error Handling
### 5.4 Loading States

---

**For complete requirements:** [product-design.md](./product-design.md)
**For technical architecture:** [tech-design.md](./tech-design.md)
