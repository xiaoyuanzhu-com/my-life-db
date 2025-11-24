/**
 * Centralized file deletion logic
 * Deletes file from filesystem and all related database records
 */

import { deleteFileRecord, deleteFilesByPrefix, listFiles } from '@/lib/db/files';
import { deleteDigestsForPath, deleteDigestsByPrefix } from '@/lib/db/digests';
import { deleteMeiliDocumentByFilePath } from '@/lib/db/meili-documents';
import { deleteQdrantDocumentsByFile } from '@/lib/db/qdrant-documents';
import { getDatabase } from '@/lib/db/connection';
import { sqlarDeletePrefix } from '@/lib/db/sqlar';
import { getLogger } from '@/lib/log/logger';
import fs from 'fs/promises';

const log = getLogger({ module: 'DeleteFile' });

/**
 * Hash function for SQLAR paths (same as coordinator)
 */
function hashPath(filePath: string): string {
  return Buffer.from(filePath).toString('base64url').slice(0, 12);
}

/**
 * Delete tasks related to a file path
 * Tasks store their input as JSON, so we need to check if filePath is in the input
 */
function deleteTasksForFile(filePath: string): number {
  const db = getDatabase();

  // Get all tasks that might reference this file
  // We'll check the JSON input field for the filePath
  const tasks = db.prepare(`
    SELECT id, type, input FROM tasks
    WHERE status IN ('to-do', 'in-progress')
    AND (
      input LIKE '%"filePath":"${filePath}"%'
      OR input LIKE '%"file_path":"${filePath}"%'
    )
  `).all() as Array<{ id: string; type: string; input: string }>;

  let deletedCount = 0;

  for (const task of tasks) {
    try {
      const input = JSON.parse(task.input);
      // Check if this task is actually for this file
      if (input.filePath === filePath || input.file_path === filePath) {
        db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
        deletedCount++;
        log.debug({ taskId: task.id, taskType: task.type, filePath }, 'deleted task for file');
      }
    } catch (error) {
      // Skip tasks with invalid JSON
      log.warn({ taskId: task.id, error }, 'failed to parse task input');
    }
  }

  return deletedCount;
}

/**
 * Delete tasks for files matching a prefix (for folder deletions)
 */
function deleteTasksForPrefix(pathPrefix: string): number {
  const db = getDatabase();

  const tasks = db.prepare(`
    SELECT id, type, input FROM tasks
    WHERE status IN ('to-do', 'in-progress')
    AND (
      input LIKE '%"filePath":"${pathPrefix}%"%'
      OR input LIKE '%"file_path":"${pathPrefix}%"%'
    )
  `).all() as Array<{ id: string; type: string; input: string }>;

  let deletedCount = 0;

  for (const task of tasks) {
    try {
      const input = JSON.parse(task.input);
      const taskFilePath = input.filePath || input.file_path;

      // Check if this task is for a file under this prefix
      if (taskFilePath && taskFilePath.startsWith(pathPrefix)) {
        db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
        deletedCount++;
        log.debug({ taskId: task.id, taskType: task.type, filePath: taskFilePath }, 'deleted task for file prefix');
      }
    } catch (error) {
      log.warn({ taskId: task.id, error }, 'failed to parse task input');
    }
  }

  return deletedCount;
}

export interface DeleteFileOptions {
  /**
   * Full filesystem path to delete
   */
  fullPath: string;

  /**
   * Relative path from data root (e.g., 'inbox/file.jpg')
   */
  relativePath: string;

  /**
   * Whether this is a folder
   */
  isFolder: boolean;
}

export interface DeleteFileResult {
  success: boolean;
  filesystemDeleted: boolean;
  databaseRecordsDeleted: {
    files: number;
    digests: number;
    sqlarFiles: number;
    meiliDocuments: number;
    qdrantDocuments: number;
    tasks: number;
  };
}

/**
 * Delete a file or folder and all related database records
 *
 * This function ensures complete cleanup of:
 * 1. Filesystem (file/folder)
 * 2. Files table (metadata cache)
 * 3. Digests table (AI-generated content)
 * 4. SQLAR table (binary artifacts like screenshots)
 * 5. Meilisearch documents (search index)
 * 6. Qdrant documents (vector search)
 * 7. Task queue (pending tasks for this file)
 */
export async function deleteFile(options: DeleteFileOptions): Promise<DeleteFileResult> {
  const { fullPath, relativePath, isFolder } = options;

  log.info({ relativePath, isFolder }, 'deleting file and all related data');

  const result: DeleteFileResult = {
    success: false,
    filesystemDeleted: false,
    databaseRecordsDeleted: {
      files: 0,
      digests: 0,
      sqlarFiles: 0,
      meiliDocuments: 0,
      qdrantDocuments: 0,
      tasks: 0,
    },
  };

  try {
    // 1. Delete from filesystem
    try {
      await fs.rm(fullPath, { recursive: true, force: true });
      result.filesystemDeleted = true;
      log.debug({ fullPath }, 'deleted from filesystem');
    } catch (error) {
      log.error({ err: error, fullPath }, 'failed to delete from filesystem');
      // Continue with database cleanup even if filesystem delete fails
    }

    if (isFolder) {
      // For folders, delete all children first
      const pathPrefix = `${relativePath}/`;

      // Get all child files for cleanup
      const childFiles = listFiles(pathPrefix);

      // Delete child file records
      deleteFilesByPrefix(pathPrefix);
      result.databaseRecordsDeleted.files += childFiles.length;

      // Delete child digests
      const digestsDeleted = deleteDigestsByPrefix(pathPrefix);
      result.databaseRecordsDeleted.digests += digestsDeleted;

      // Delete SQLAR artifacts for all children
      for (const child of childFiles) {
        const childHash = hashPath(child.path);
        const sqlarDeleted = sqlarDeletePrefix(getDatabase(), `${childHash}/`);
        result.databaseRecordsDeleted.sqlarFiles += sqlarDeleted;

        // Delete Meilisearch documents for children
        try {
          deleteMeiliDocumentByFilePath(child.path);
          result.databaseRecordsDeleted.meiliDocuments++;
        } catch (error) {
          // Document might not exist, that's ok
          log.debug({ filePath: child.path }, 'no meili document to delete');
        }

        // Delete Qdrant documents for children
        const qdrantDeleted = deleteQdrantDocumentsByFile(child.path);
        result.databaseRecordsDeleted.qdrantDocuments += qdrantDeleted;
      }

      // Delete tasks for children
      const tasksDeleted = deleteTasksForPrefix(pathPrefix);
      result.databaseRecordsDeleted.tasks += tasksDeleted;
    }

    // Delete the folder/file record itself
    deleteFileRecord(relativePath);
    result.databaseRecordsDeleted.files++;

    // Delete digests for this path
    const digestsDeleted = deleteDigestsForPath(relativePath);
    result.databaseRecordsDeleted.digests += digestsDeleted;

    // Delete SQLAR artifacts
    const pathHash = hashPath(relativePath);
    const sqlarDeleted = sqlarDeletePrefix(getDatabase(), `${pathHash}/`);
    result.databaseRecordsDeleted.sqlarFiles += sqlarDeleted;

    // Delete Meilisearch document
    try {
      deleteMeiliDocumentByFilePath(relativePath);
      result.databaseRecordsDeleted.meiliDocuments++;
    } catch (error) {
      // Document might not exist, that's ok
      log.debug({ relativePath }, 'no meili document to delete');
    }

    // Delete Qdrant documents
    const qdrantDeleted = deleteQdrantDocumentsByFile(relativePath);
    result.databaseRecordsDeleted.qdrantDocuments += qdrantDeleted;

    // Delete tasks
    const tasksDeleted = deleteTasksForFile(relativePath);
    result.databaseRecordsDeleted.tasks += tasksDeleted;

    result.success = true;

    log.info(
      {
        relativePath,
        isFolder,
        filesystemDeleted: result.filesystemDeleted,
        ...result.databaseRecordsDeleted,
      },
      'file deletion complete'
    );

    return result;
  } catch (error) {
    log.error({ err: error, relativePath }, 'failed to delete file');
    throw error;
  }
}
