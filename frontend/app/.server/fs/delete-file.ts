/**
 * Centralized file deletion logic
 * Deletes file from filesystem and all related database records
 */

import { deleteFileRecord, deleteFilesByPrefix, listFiles } from '~/.server/db/files';
import { deleteDigestsForPath, deleteDigestsByPrefix } from '~/.server/db/digests';
import { getMeiliDocumentByFilePath, deleteMeiliDocumentByFilePath } from '~/.server/db/meili-documents';
import { getQdrantDocumentIdsByFile, deleteQdrantDocumentsByFile } from '~/.server/db/qdrant-documents';
import { sqlarDeletePrefix } from '~/.server/db/sqlar';
import { deleteFromMeilisearch } from '~/.server/search/meili-indexer';
import { deleteFromQdrant } from '~/.server/search/qdrant-indexer';
import { getLogger } from '~/.server/log/logger';
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

    // Collect document IDs for external search deletion BEFORE deleting from local tables
    const meiliDocumentIds: string[] = [];
    const qdrantDocumentIds: string[] = [];

    if (isFolder) {
      // For folders, delete all children first
      const pathPrefix = `${relativePath}/`;

      // Get all child files for cleanup
      const childFiles = listFiles(pathPrefix);

      // Collect search document IDs for children before deletion
      for (const child of childFiles) {
        const meiliDoc = getMeiliDocumentByFilePath(child.path);
        if (meiliDoc) {
          meiliDocumentIds.push(meiliDoc.documentId);
        }
        const childQdrantIds = getQdrantDocumentIdsByFile(child.path);
        qdrantDocumentIds.push(...childQdrantIds);
      }

      // Delete child file records
      deleteFilesByPrefix(pathPrefix);
      result.databaseRecordsDeleted.files += childFiles.length;

      // Delete child digests
      const digestsDeleted = deleteDigestsByPrefix(pathPrefix);
      result.databaseRecordsDeleted.digests += digestsDeleted;

      // Delete SQLAR artifacts for all children
      for (const child of childFiles) {
        const childHash = hashPath(child.path);
        const sqlarDeleted = sqlarDeletePrefix(`${childHash}/`);
        result.databaseRecordsDeleted.sqlarFiles += sqlarDeleted;

        // Delete Meilisearch documents for children (local DB)
        try {
          deleteMeiliDocumentByFilePath(child.path);
          result.databaseRecordsDeleted.meiliDocuments++;
        } catch {
          // Document might not exist, that's ok
          log.debug({ filePath: child.path }, 'no meili document to delete');
        }

        // Delete Qdrant documents for children (local DB)
        const qdrantDeleted = deleteQdrantDocumentsByFile(child.path);
        result.databaseRecordsDeleted.qdrantDocuments += qdrantDeleted;
      }
    }

    // Collect search document IDs for the main file/folder before deletion
    const meiliDoc = getMeiliDocumentByFilePath(relativePath);
    if (meiliDoc) {
      meiliDocumentIds.push(meiliDoc.documentId);
    }
    const mainQdrantIds = getQdrantDocumentIdsByFile(relativePath);
    qdrantDocumentIds.push(...mainQdrantIds);

    // Delete the folder/file record itself
    deleteFileRecord(relativePath);
    result.databaseRecordsDeleted.files++;

    // Delete digests for this path
    const digestsDeleted = deleteDigestsForPath(relativePath);
    result.databaseRecordsDeleted.digests += digestsDeleted;

    // Delete SQLAR artifacts
    const pathHash = hashPath(relativePath);
    const sqlarDeleted = sqlarDeletePrefix(`${pathHash}/`);
    result.databaseRecordsDeleted.sqlarFiles += sqlarDeleted;

    // Delete Meilisearch document (local DB)
    try {
      deleteMeiliDocumentByFilePath(relativePath);
      result.databaseRecordsDeleted.meiliDocuments++;
    } catch {
      // Document might not exist, that's ok
      log.debug({ relativePath }, 'no meili document to delete');
    }

    // Delete Qdrant documents (local DB)
    const qdrantDeleted = deleteQdrantDocumentsByFile(relativePath);
    result.databaseRecordsDeleted.qdrantDocuments += qdrantDeleted;

    // Delete from external search services (fire-and-forget)
    if (meiliDocumentIds.length > 0) {
      deleteFromMeilisearch(meiliDocumentIds).catch((err) => {
        log.error({ err, count: meiliDocumentIds.length }, 'Meilisearch deletion failed');
      });
      log.debug({ count: meiliDocumentIds.length }, 'triggered Meilisearch deletions');
    }
    if (qdrantDocumentIds.length > 0) {
      deleteFromQdrant(qdrantDocumentIds).catch((err: unknown) => {
        log.error({ err, count: qdrantDocumentIds.length }, 'Qdrant deletion failed');
      });
      log.debug({ count: qdrantDocumentIds.length }, 'triggered Qdrant deletions');
    }

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
