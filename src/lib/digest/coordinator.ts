/**
 * Digest Coordinator
 * Orchestrates digest processing for files
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { Digest, FileRecordRow } from '@/types';
import { globalDigesterRegistry } from './registry';
import { getFileByPath } from '@/lib/db/files';
import {
  listDigestsForPath,
  generateDigestId,
  getDigestById,
  createDigest,
  updateDigest,
} from '@/lib/db/digests';
import { sqlarStore } from '@/lib/db/sqlar';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'DigestCoordinator' });

/**
 * Hash function for generating SQLAR paths
 */
function hashPath(filePath: string): string {
  return Buffer.from(filePath).toString('base64url').slice(0, 12);
}

/**
 * Digest Coordinator
 * Processes files through all registered digesters sequentially
 */
export class DigestCoordinator {
  constructor(private db: BetterSqlite3.Database) {}

  /**
   * Process a file through all digesters.
   * Self-managed - returns void, logs progress internally.
   *
   * @param filePath Path to file to process
   */
  async processFile(filePath: string): Promise<void> {
    log.info({ filePath }, 'processing file');

    // 1. Load file metadata
    const fileRecord = getFileByPath(filePath);
    if (!fileRecord) {
      log.error({ filePath }, 'file not found');
      return;
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
    };

    // 2. Get all digesters in registration order
    const digesters = globalDigesterRegistry.getAll();

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    // 3. Process each digester sequentially
    for (const digester of digesters) {
      try {
        // Load fresh digest state for this iteration
        const existingDigests = listDigestsForPath(filePath);

        // Get digester name from constructor
        const digesterName = digester.constructor.name
          .replace('Digester', '')
          .replace(/([A-Z])/g, '-$1')
          .toLowerCase()
          .slice(1);

        // Check if already completed
        const existing = existingDigests.find((d) => d.digester === digesterName);

        if (existing?.status === 'completed') {
          log.debug({ filePath, digester: digesterName }, 'already completed, skipping');
          skipped++;
          continue;
        }

        // Check if can digest
        const can = await digester.canDigest(filePath, file, existingDigests, this.db);

        if (!can) {
          // Mark as skipped (not applicable)
          await this.upsertDigest(filePath, digesterName, {
            status: 'skipped',
            error: 'Not applicable',
          });
          log.debug({ filePath, digester: digesterName }, 'not applicable, skipped');
          skipped++;
          continue;
        }

        // Mark as in-progress
        await this.upsertDigest(filePath, digesterName, { status: 'in-progress' });

        log.info({ filePath, digester: digesterName }, 'running digester');

        // Execute digester
        const outputs = await digester.digest(filePath, file, existingDigests, this.db);

        if (outputs === null) {
          // Digester decided to skip
          await this.upsertDigest(filePath, digesterName, {
            status: 'skipped',
            error: 'Digester returned null',
          });
          log.debug({ filePath, digester: digesterName }, 'digester returned null, skipped');
          skipped++;
          continue;
        }

        // Save outputs (each digest saved immediately - Option A)
        for (const digest of outputs) {
          await this.saveDigestOutput(filePath, digest);
        }

        processed++;
        log.info({ filePath, digester: digesterName }, 'digester completed');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const digesterName = digester.constructor.name
          .replace('Digester', '')
          .replace(/([A-Z])/g, '-$1')
          .toLowerCase()
          .slice(1);

        log.error({ filePath, digester: digesterName, error: errorMsg }, 'digester failed');

        // Mark as failed
        await this.upsertDigest(filePath, digesterName, {
          status: 'failed',
          error: errorMsg,
        });

        failed++;
      }
    }

    log.info(
      { filePath, processed, skipped, failed, total: digesters.length },
      'processing complete'
    );
  }

  /**
   * Create or update digest record
   */
  private async upsertDigest(
    filePath: string,
    digester: string,
    updates: Partial<Digest>
  ): Promise<void> {
    const id = generateDigestId(filePath, digester);
    const existing = getDigestById(id);

    if (existing) {
      // Update existing
      updateDigest(id, {
        ...updates,
        updatedAt: new Date().toISOString(),
      });
    } else {
      // Create new
      const digest: Digest = {
        id,
        filePath,
        digester,
        status: updates.status || 'todo',
        content: updates.content ?? null,
        sqlarName: updates.sqlarName ?? null,
        error: updates.error ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      createDigest(digest);
    }
  }

  /**
   * Save digest output (text content + binary artifacts)
   */
  private async saveDigestOutput(filePath: string, output: Digest): Promise<void> {
    const id = generateDigestId(filePath, output.digester);

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
      // Update
      updateDigest(id, {
        status: 'completed',
        content: output.content,
        sqlarName: sqlarName || existing.sqlarName,
        error: null,
        updatedAt: new Date().toISOString(),
      });
    } else {
      // Create new
      const digest: Digest = {
        id,
        filePath: output.filePath,
        digester: output.digester,
        status: 'completed',
        content: output.content,
        sqlarName,
        error: null,
        createdAt: output.createdAt || new Date().toISOString(),
        updatedAt: output.updatedAt || new Date().toISOString(),
      };
      createDigest(digest);
    }

    log.debug({ filePath, digester: output.digester }, 'digest saved');
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
    const id = generateDigestId(filePath, digester);
    updateDigest(id, {
      sqlarName,
      updatedAt: new Date().toISOString(),
    });

    log.debug({ filePath, digester, sqlarName }, 'binary artifact saved');
  }
}
