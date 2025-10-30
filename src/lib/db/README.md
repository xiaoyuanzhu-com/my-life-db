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

### Settings Table (Key-Value)

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,                    -- Setting key (e.g., 'vendors.openai.apiKey')
  value TEXT NOT NULL,                     -- Setting value (stored as string)
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Example rows:**
```
key                          | value                        | updated_at
----------------------------|------------------------------|-------------------
ai_provider                 | openai                       | 2025-10-27 10:00:00
vendors_openai_api_key      | sk-Fl_XqG9l0PRiU8W8z5oPkQ   | 2025-10-27 10:00:00
vendors_openai_base_url     | https://api.openai.com/v1   | 2025-10-27 10:00:00
extraction_auto_enrich      | false                        | 2025-10-27 10:00:00
```

**Key Naming Convention:**
- Uses snake_case format
- Nested properties separated by underscores
- Examples: `vendors_openai_api_key`, `ai_provider`, `extraction_auto_enrich`

## Environment Variables

- `MY_DATA_DIR`: Base directory for all application data (optional, defaults to `./data`)
