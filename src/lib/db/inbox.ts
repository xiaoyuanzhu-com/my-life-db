// Database operations for inbox items (now stored in items table)
import { getDatabase } from './connection';
import type { InboxItem, InboxFile, ItemFile, Item } from '@/types';
import { createItem, getItemById, getItemByPath, listItems, updateItem, deleteItem } from './items';

/**
 * Convert InboxFile to ItemFile format
 */
function inboxFileToItemFile(file: InboxFile): ItemFile {
  return {
    name: file.filename,
    size: file.size,
    type: file.mimeType,
    hash: file.hash,
  };
}

/**
 * Determine FileType from MIME type
 */
function getFileTypeFromMimeType(mimeType: string): InboxFile['type'] {
  if (mimeType.startsWith('text/')) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'other';
}

/**
 * Convert ItemFile to InboxFile format
 */
function itemFileToInboxFile(file: ItemFile): InboxFile {
  return {
    filename: file.name,
    size: file.size,
    mimeType: file.type,
    type: getFileTypeFromMimeType(file.type),
    hash: file.hash,
  };
}

/**
 * Convert Item to InboxItem format
 */
function itemToInboxItem(item: Item, aiSlug: string | null = null): InboxItem {
  const folderName = item.path.replace(/^inbox\//, '');

  return {
    id: item.id,
    folderName,
    type: item.rawType,
    files: item.files ? item.files.map(itemFileToInboxFile) : [],
    status: item.status,
    enrichedAt: null, // No longer stored in items table
    error: null, // No longer stored in items table
    aiSlug,
    schemaVersion: item.schemaVersion,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * Create a new inbox item in the database
 */
export function createInboxRecord(item: InboxItem): void {
  // Convert InboxItem to Item format
  const itemFiles = item.files.map(inboxFileToItemFile);

  createItem({
    id: item.id,
    name: item.folderName,
    rawType: item.type,
    detectedType: null, // Will be set during enrichment
    isFolder: item.files.length > 1, // Multi-file items are folders
    path: `inbox/${item.folderName}`,
    files: itemFiles,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    schemaVersion: item.schemaVersion,
  });

  // Store aiSlug in digests table if present
  if (item.aiSlug) {
    const db = getDatabase();
    db.prepare(`
      INSERT OR REPLACE INTO digests (id, item_id, digest_type, status, content, created_at, updated_at)
      VALUES (?, ?, 'slug', 'completed', ?, ?, ?)
    `).run(
      `${item.id}-slug`,
      item.id,
      item.aiSlug,
      item.createdAt,
      item.updatedAt
    );
  }
}

/**
 * Get an inbox item by ID
 */
export function getInboxItemById(id: string): InboxItem | null {
  const item = getItemById(id);
  if (!item || !item.path.startsWith('inbox/')) return null;

  // Get aiSlug from digests table
  const db = getDatabase();
  const slugDigest = db
    .prepare('SELECT content FROM digests WHERE item_id = ? AND digest_type = ?')
    .get(id, 'slug') as { content: string } | undefined;

  return itemToInboxItem(item, slugDigest?.content || null);
}

/**
 * Get an inbox item by folder name
 */
export function getInboxItemByFolderName(folderName: string): InboxItem | null {
  const item = getItemByPath(`inbox/${folderName}`);
  if (!item) return null;

  // Get aiSlug from digests table
  const db = getDatabase();
  const slugDigest = db
    .prepare('SELECT content FROM digests WHERE item_id = ? AND digest_type = ?')
    .get(item.id, 'slug') as { content: string } | undefined;

  return itemToInboxItem(item, slugDigest?.content || null);
}

/**
 * Get an inbox item by generated slug (ai_slug)
 */
export function getInboxItemBySlug(slug: string): InboxItem | null {
  if (!slug || slug.trim().length === 0) return null;

  const db = getDatabase();

  // Find item ID from digests table
  const slugDigest = db
    .prepare('SELECT item_id FROM digests WHERE digest_type = ? AND content = ?')
    .get('slug', slug) as { item_id: string } | undefined;

  if (!slugDigest) return null;

  const item = getItemById(slugDigest.item_id);
  if (!item || !item.path.startsWith('inbox/')) return null;

  return itemToInboxItem(item, slug);
}

/**
 * List all inbox items
 */
export function listInboxItems(options?: {
  status?: string;
  limit?: number;
  offset?: number;
}): InboxItem[] {
  const items = listItems({
    location: 'inbox',
    status: options?.status,
    limit: options?.limit,
    offset: options?.offset,
  });

  // Get aiSlug for each item from digests table
  const db = getDatabase();
  return items.map(item => {
    const slugDigest = db
      .prepare('SELECT content FROM digests WHERE item_id = ? AND digest_type = ?')
      .get(item.id, 'slug') as { content: string } | undefined;

    return itemToInboxItem(item, slugDigest?.content || null);
  });
}

/**
 * Update an inbox item
 */
export function updateInboxItem(
  id: string,
  updates: Partial<Omit<InboxItem, 'id' | 'createdAt'>>
): void {
  const db = getDatabase();

  // Prepare updates for items table
  const itemUpdates: Parameters<typeof updateItem>[1] = {};

  if (updates.folderName !== undefined) {
    itemUpdates.name = updates.folderName;
    itemUpdates.path = `inbox/${updates.folderName}`;
  }

  if (updates.type !== undefined) {
    itemUpdates.rawType = updates.type;
  }

  if (updates.files !== undefined) {
    itemUpdates.files = updates.files.map(inboxFileToItemFile);
  }

  if (updates.status !== undefined) {
    itemUpdates.status = updates.status;
  }

  if (updates.schemaVersion !== undefined) {
    itemUpdates.schemaVersion = updates.schemaVersion;
  }

  // Update items table
  if (Object.keys(itemUpdates).length > 0) {
    updateItem(id, itemUpdates);
  }

  // Update aiSlug in digests table
  if (updates.aiSlug !== undefined) {
    const now = new Date().toISOString();
    if (updates.aiSlug) {
      db.prepare(`
        INSERT OR REPLACE INTO digests (id, item_id, digest_type, status, content, created_at, updated_at)
        VALUES (?, ?, 'slug', 'completed', ?, ?, ?)
      `).run(`${id}-slug`, id, updates.aiSlug, now, now);
    } else {
      // Delete slug digest if set to null
      db.prepare('DELETE FROM digests WHERE item_id = ? AND digest_type = ?')
        .run(id, 'slug');
    }
  }

  // Note: enrichedAt and error are no longer stored in the database
  // They were used for tracking enrichment progress, which is now handled by inbox_task_state
}

/**
 * Delete an inbox item
 */
export function deleteInboxItem(id: string): void {
  // deleteItem will cascade delete from digests table due to foreign key
  deleteItem(id);
}
