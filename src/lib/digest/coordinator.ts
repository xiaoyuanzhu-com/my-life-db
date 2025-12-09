/**
 * Digest Coordinator
 * Orchestrates digest processing for files
 */

import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Digest, DigestInput, FileRecordRow } from '@/types';
import type { Digester } from './types';
import { globalDigesterRegistry } from './registry';
import { MAX_DIGEST_ATTEMPTS } from './constants';
import { getFileByPath, updateFileScreenshotSqlar } from '@/lib/db/files';
import {
  listDigestsForPath,
  getDigestById,
  getDigestByPathAndDigester,
  createDigest,
  updateDigest,
} from '@/lib/db/digests';
import { sqlarStore, sqlarDeletePrefix } from '@/lib/db/sqlar';
import { withDatabase } from '@/lib/db/client';
import { tryAcquireLock, releaseLock } from '@/lib/db/processing-locks';
import { getLogger } from '@/lib/log/logger';
import { deleteEmbeddingsForSource } from '@/lib/db/people';

const log = getLogger({ module: 'DigestCoordinator' });

/**
 * Hash function for generating SQLAR paths
 */
function hashPath(filePath: string): string {
  return Buffer.from(filePath).toString('base64url').slice(0, 12);
}

function hasReachedMaxAttempts(digest: Digest): boolean {
  return digest.status === 'failed' && digest.attempts >= MAX_DIGEST_ATTEMPTS;
}

function deriveFinalError(
  baseError: string | null,
  status: Digest['status'],
  attempts: number
): string | null {
  if (status === 'in-progress') {
    return null;
  }

  if (status === 'failed' && attempts >= MAX_DIGEST_ATTEMPTS) {
    return baseError ? `${baseError} (max attempts reached)` : 'Max attempts reached';
  }

  return baseError;
}

/**
 * Digest Coordinator
 * Processes files through all registered digesters sequentially
 */
export class DigestCoordinator {
  constructor(private db: BetterSqlite3.Database = withDatabase(db => db)) {}

  /**
   * Process a file through all digesters.
   * Self-managed - returns void, logs progress internally.
   *
   * @param filePath Path to file to process
   * @param options.reset If true, reset digests before processing
   * @param options.digester If provided, only reset and reprocess this specific digester
   */
  async processFile(filePath: string, options?: { reset?: boolean; digester?: string }): Promise<void> {
    // Try to acquire database-level lock (prevents concurrent processing across processes)
    if (!tryAcquireLock(filePath, 'DigestCoordinator')) {
      log.debug({ filePath }, 'file is already being processed, skipping');
      return;
    }

    try {
      log.debug({ filePath }, 'processing file');

      // 1. Load file metadata
      const fileRecord = getFileByPath(filePath);
      if (!fileRecord) {
        log.error({ filePath }, 'file not found');
        return;
      }

    if (options?.reset) {
      this.resetDigests(filePath, options.digester);
    }

    // Convert to FileRecordRow (DB format)
    const file: FileRecordRow = {
      path: fileRecord.path,
      name: fileRecord.name,
      is_folder: fileRecord.isFolder ? 1 : 0,
      size: fileRecord.size,
      mime_type: fileRecord.mimeType,
      hash: fileRecord.hash,
      modified_at: fileRecord.modifiedAt,
      created_at: fileRecord.createdAt,
      last_scanned_at: fileRecord.lastScannedAt,
      text_preview: fileRecord.textPreview,
      screenshot_sqlar: fileRecord.screenshotSqlar,
    };

    // 2. Get all digesters in registration order
    const digesters = globalDigesterRegistry.getAll();

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    // 3. Process each digester sequentially
    for (const digester of digesters) {
      const digesterName = digester.name;
      const outputNames = this.getOutputNames(digester);
      let pendingOutputs: string[] = [];

      try {
        // Load fresh digest state for this iteration
        const existingDigests = listDigestsForPath(filePath);
        const digestsByName = new Map(existingDigests.map((d) => [d.digester, d]));

        const outputsInProgress = outputNames.some((name) => {
          const digest = digestsByName.get(name);
          return digest?.status === 'in-progress';
        });

        if (outputsInProgress) {
          log.info({ filePath }, `[${digesterName}] in-progress`);
          skipped++;
          continue;
        }

        pendingOutputs = outputNames.filter((name) => {
          const digest = digestsByName.get(name);
          if (!digest) return true;
          if (digest.status === 'failed') {
            return !hasReachedMaxAttempts(digest);
          }
          return digest.status === 'todo';
        });

        if (pendingOutputs.length === 0) {
          // Already terminal - derive status from output digests
          const outputStatuses = outputNames.map((name) => digestsByName.get(name)?.status);
          const existingStatus = outputStatuses.includes('completed')
            ? 'completed'
            : outputStatuses.includes('skipped')
              ? 'skipped'
              : outputStatuses[0] ?? 'completed';
          log.info({ filePath }, `[${digesterName}] already ${existingStatus}`);
          skipped++;
          continue;
        }

        // Check if can digest
        const can = await digester.canDigest(filePath, file, existingDigests, this.db);

        if (!can) {
          this.markDigests(filePath, pendingOutputs, 'skipped', 'Not applicable');
          log.info({ filePath }, `[${digesterName}] skipped`);
          skipped++;
          continue;
        }

        // Mark pending outputs as in-progress
        this.markDigests(filePath, pendingOutputs, 'in-progress', null, { incrementAttempts: true });

        // Execute digester
        const outputs = await digester.digest(filePath, file, existingDigests, this.db);

        if (!outputs || outputs.length === 0) {
          this.markDigests(filePath, pendingOutputs, 'skipped', 'Digester returned no output');
          log.info({ filePath }, `[${digesterName}] skipped`);
          skipped++;
          continue;
        }

        const producedNames = new Set<string>();
        let finalStatus: string = 'completed';

        for (const digest of outputs) {
          producedNames.add(digest.digester);
          await this.saveDigestOutput(filePath, digest);
          // Track if any output failed
          if (digest.status === 'failed') {
            finalStatus = 'failed';
          }
        }

        const missingOutputs = pendingOutputs.filter((name) => !producedNames.has(name));
        if (missingOutputs.length > 0) {
          this.markDigests(filePath, missingOutputs, 'skipped', 'Output not produced');
        }

        processed++;
        log.info({ filePath }, `[${digesterName}] ${finalStatus}`);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const targets = pendingOutputs.length > 0 ? pendingOutputs : outputNames;
        this.markDigests(filePath, targets, 'failed', err.message);
        log.error({ filePath, error: err.message }, `[${digesterName}] failed`);
        failed++;
      }
    }

    log.info(
      { filePath, processed, skipped, failed, total: digesters.length },
      'processing complete'
    );
  } finally {
      // Always release the database lock
      releaseLock(filePath);
    }
  }

  /**
   * Save digest output (text content + binary artifacts)
   */
  private async saveDigestOutput(filePath: string, output: DigestInput): Promise<void> {
    const id = output.id || this.createOrGetDigestId(filePath, output.digester);
    const targetStatus = output.status ?? 'completed';

    // Check if digest has binary artifacts in sqlar
    // (we need to extract sqlarName from existing digest if present)
    let sqlarName: string | null = null;

    // If output has sqlarName set, use it
    if (output.sqlarName) {
      sqlarName = output.sqlarName;
    }

    // Update or create digest record
    const existing = getDigestById(id);

    if (existing) {
      // Update - cap attempts at MAX_DIGEST_ATTEMPTS for consistency
      const attempts = targetStatus === 'failed'
        ? Math.min(MAX_DIGEST_ATTEMPTS, (existing.attempts ?? 0) + 1)
        : 0;
      updateDigest(id, {
        status: targetStatus,
        content: output.content,
        sqlarName: sqlarName || existing.sqlarName,
        error: output.error ?? null,
        attempts,
      });
    } else {
      // Create new
      const digest: Digest = {
        id,
        filePath: output.filePath,
        digester: output.digester,
        status: targetStatus,
        content: output.content,
        sqlarName,
        error: output.error ?? null,
        attempts: targetStatus === 'failed' ? 1 : 0,
        createdAt: output.createdAt || new Date().toISOString(),
        updatedAt: output.updatedAt || new Date().toISOString(),
      };
      createDigest(digest);
    }

    log.debug({ filePath, digester: output.digester }, 'digest saved');

    // Sync screenshot_sqlar to files table for fast inbox queries
    if (output.digester.includes('screenshot') && targetStatus === 'completed' && output.sqlarName) {
      updateFileScreenshotSqlar(filePath, output.sqlarName);
    }
  }

  /**
   * Save binary artifact to SQLAR and update digest with sqlar_name
   * (Helper for digesters that produce binary outputs)
   */
  async saveBinaryArtifact(
    filePath: string,
    digester: string,
    filename: string,
    data: Buffer
  ): Promise<void> {
    const pathHash = hashPath(filePath);
    const sqlarName = `${pathHash}/${digester}/${filename}`;

    // Store in SQLAR
    await sqlarStore(this.db, sqlarName, data);

    // Update digest with sqlar_name
    const id = this.createOrGetDigestId(filePath, digester);
    updateDigest(id, {
      sqlarName,
      updatedAt: new Date().toISOString(),
    });

    log.debug({ filePath, digester, sqlarName }, 'binary artifact saved');
  }

  /**
   * Remove existing digests and SQLAR artifacts before reprocessing a file
   * @param filePath Path to file
   * @param digester If provided, only reset this specific digester
   */
  private resetDigests(filePath: string, digester?: string): void {
    log.debug({ filePath, digester }, 'resetting digests');
    // Reset attempts to 0 so user can trigger a fresh retry cycle
    const existing = listDigestsForPath(filePath);
    const pathHash = hashPath(filePath);

    for (const digest of existing) {
      // If digester is specified, only reset that one
      if (digester && digest.digester !== digester) {
        continue;
      }

      updateDigest(digest.id, {
        status: 'todo',
        content: null,
        sqlarName: null,
        error: null,
        attempts: 0,
      });

      // Delete SQLAR artifacts for this specific digester
      if (digest.sqlarName) {
        sqlarDeletePrefix(this.db, `${pathHash}/${digest.digester}/`);
      }

      // Delete embeddings when resetting speaker-embedding
      if (digest.digester === 'speaker-embedding') {
        const deleted = deleteEmbeddingsForSource(filePath);
        log.debug({ filePath, deleted }, 'deleted embeddings for source');
      }

      // Clear screenshot_sqlar cache when resetting screenshot digesters
      if (digest.digester.includes('screenshot')) {
        updateFileScreenshotSqlar(filePath, null);
      }
    }

    // If resetting all digests, delete all SQLAR artifacts for the file
    if (!digester) {
      sqlarDeletePrefix(this.db, `${pathHash}/`);
    }
  }

  private getOutputNames(digester: Digester): string[] {
    const outputs = digester.getOutputDigesters?.();
    if (outputs && outputs.length > 0) {
      return outputs;
    }
    return [digester.name];
  }

  /**
   * Get existing digest id or create a placeholder with a new UUID
   */
  private createOrGetDigestId(filePath: string, digester: string): string {
    const existing = getDigestByPathAndDigester(filePath, digester);
    if (existing) return existing.id;

    const id = randomUUID();
    const now = new Date().toISOString();
    createDigest({
      id,
      filePath,
      digester,
      status: 'todo',
      content: null,
      sqlarName: null,
      error: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  private markDigests(
    filePath: string,
    digesterNames: string[],
    status: Digest['status'],
    error?: string | null,
    options?: { incrementAttempts?: boolean }
  ): void {
    if (digesterNames.length === 0) return;
    const now = new Date().toISOString();
    const baseError = status === 'in-progress' ? null : error ?? null;

    for (const name of digesterNames) {
      const id = this.createOrGetDigestId(filePath, name);
      const existing = getDigestById(id);
      if (existing) {
        let attempts = existing.attempts ?? 0;
        const shouldIncrement = options?.incrementAttempts === true;
        if (shouldIncrement) {
          attempts = Math.min(MAX_DIGEST_ATTEMPTS, attempts + 1);
        } else if (status === 'completed' || status === 'skipped') {
          attempts = 0;
        } else if (status === 'failed') {
          attempts = Math.min(MAX_DIGEST_ATTEMPTS, attempts + 1);
        }

        updateDigest(id, {
          status,
          error: deriveFinalError(baseError, status, attempts),
          attempts,
        });
        continue;
      }

      const attempts = status === 'failed' ? 1 : 0;
      createDigest({
        id,
        filePath,
        digester: name,
        status,
        content: null,
        sqlarName: null,
        error: deriveFinalError(baseError, status, attempts),
        attempts,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}
