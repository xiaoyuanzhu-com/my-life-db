# Database Module

This module handles SQLite database connections and operations for MyLifeDB.

## Overview

- **Database Engine**: SQLite via `better-sqlite3`
- **Location**: `MY_DATA_DIR/.app/mylifedb/database.sqlite`
- **Default Path**: `./data/.app/mylifedb/database.sqlite` (if `MY_DATA_DIR` is not set)

## Features

- Automatic database initialization
- Schema migration on first run
- Singleton connection pattern
- Foreign key support enabled

## Usage

```typescript
import { getDatabase } from '@/lib/db/connection';

// Get database instance
const db = getDatabase();

// Use prepared statements
const stmt = db.prepare('SELECT * FROM settings WHERE id = ?');
const result = stmt.get(1);
```

## Schema

### Settings Table

```sql
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- Ensures only one settings row
  data TEXT NOT NULL,                      -- JSON-serialized settings
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Environment Variables

- `MY_DATA_DIR`: Base directory for all application data (optional, defaults to `./data`)
