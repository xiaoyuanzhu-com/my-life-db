/**
 * Digest Coordinator
 * Orchestrates digest processing for files
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { Digest, FileRecordRow } from '@/types';
import type { Digester } from './types';
import { globalDigesterRegistry } from './registry';
import { MAX_DIGEST_ATTEMPTS } from './constants';
import { getFileByPath } from '@/lib/db/files';
import {
  listDigestsForPath,
  generateDigestId,
  getDigestById,
  createDigest,
  updateDigest,
  deleteDigestsForPath,
} from '@/lib/db/digests';
import { sqlarStore, sqlarDeletePrefix } from '@/lib/db/sqlar';
import { getLogger } from '@/lib/log/logger';
import { notificationService } from '@/lib/notifications/notification-service';

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
  constructor(private db: BetterSqlite3.Database) {}

  /**
   * Process a file through all digesters.
   * Self-managed - returns void, logs progress internally.
   *
   * @param filePath Path to file to process
   */
  async processFile(filePath: string, options?: { reset?: boolean }): Promise<void> {
    log.info({ filePath }, 'processing file');

    // 1. Load file metadata
    const fileRecord = getFileByPath(filePath);
    if (!fileRecord) {
      log.error({ filePath }, 'file not found');
      return;
    }

    if (options?.reset) {
      this.resetDigests(filePath);
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
    this.ensureDigestPlaceholders(filePath, digesters);

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
          log.debug({ filePath, digester: digesterName }, 'outputs currently in progress, skipping');
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
          log.debug({ filePath, digester: digesterName }, 'outputs already terminal, skipping');
          skipped++;
          continue;
        }

        // Check if can digest
        const can = await digester.canDigest(filePath, file, existingDigests, this.db);

        if (!can) {
          const reason = digesterName === 'url-crawl' ? 'File does not contain a URL' : 'Not applicable';
          this.markDigests(filePath, pendingOutputs, 'skipped', reason);
          log.debug({ filePath, digester: digesterName }, 'not applicable, skipped');
          skipped++;
          continue;
        }

        // Mark pending outputs as in-progress
        this.markDigests(filePath, pendingOutputs, 'in-progress', null, { incrementAttempts: true });

        log.debug({ filePath, digester: digesterName }, 'running digester');

        // Execute digester
        const outputs = await digester.digest(filePath, file, existingDigests, this.db);

        if (!outputs || outputs.length === 0) {
          this.markDigests(filePath, pendingOutputs, 'skipped', 'Digester returned no output');
          log.debug({ filePath, digester: digesterName }, 'digester returned no output, skipped');
          skipped++;
          continue;
        }

        const producedNames = new Set<string>();

        for (const digest of outputs) {
          producedNames.add(digest.digester);
          await this.saveDigestOutput(filePath, digest);
        }

        const missingOutputs = pendingOutputs.filter((name) => !producedNames.has(name));
        if (missingOutputs.length > 0) {
          this.markDigests(filePath, missingOutputs, 'skipped', 'Output not produced');
        }

        processed++;
        log.debug({ filePath, digester: digesterName }, 'digester completed');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.error({ filePath, digester: digesterName, error: errorMsg }, 'digester failed');

        const targets = pendingOutputs.length > 0 ? pendingOutputs : outputNames;
        this.markDigests(filePath, targets, 'failed', errorMsg);

        failed++;
      }
    }

    log.info(
      { filePath, processed, skipped, failed, total: digesters.length },
      'processing complete'
    );

  }

  /**
   * Save digest output (text content + binary artifacts)
   */
  private async saveDigestOutput(filePath: string, output: Digest): Promise<void> {
    const id = generateDigestId(filePath, output.digester);
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
      // Update
      updateDigest(id, {
        status: targetStatus,
        content: output.content,
        sqlarName: sqlarName || existing.sqlarName,
        error: output.error ?? null,
        attempts: targetStatus === 'failed' ? (existing.attempts ?? 0) + 1 : 0,
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

  /**
   * Ensure placeholder digests exist for all outputs before processing begins.
   */
  private ensureDigestPlaceholders(filePath: string, digesters: Digester[]): void {
    const existing = listDigestsForPath(filePath, { order: 'asc' });
    const existingTypes = new Set(existing.map((d) => d.digester));
    const baseTime = Date.now();
    let offset = 0;

    for (const digester of digesters) {
      const outputs = this.getOutputNames(digester);
      for (const outputName of outputs) {
        if (existingTypes.has(outputName)) {
          continue;
        }

        const timestamp = new Date(baseTime + offset).toISOString();
        offset++;

        const digest: Digest = {
          id: generateDigestId(filePath, outputName),
          filePath,
          digester: outputName,
          status: 'todo',
          content: null,
          sqlarName: null,
          error: null,
          attempts: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        try {
          createDigest(digest);
          existingTypes.add(outputName);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (!errorMsg.includes('UNIQUE constraint')) {
            log.error({ filePath, digester: outputName, error: errorMsg }, 'failed to create digest placeholder');
          }
        }
      }
    }
  }

  /**
   * Remove existing digests and SQLAR artifacts before reprocessing a file
   */
  private resetDigests(filePath: string): void {
    log.info({ filePath }, 'resetting digests before processing');

    // Preserve attempt counts so max-attempts logic still applies after a reset
    const existing = listDigestsForPath(filePath);
    for (const digest of existing) {
      updateDigest(digest.id, {
        status: 'todo',
        content: null,
        sqlarName: null,
        error: null,
        attempts: digest.attempts ?? 0,
      });
    }

    const pathHash = hashPath(filePath);
    sqlarDeletePrefix(this.db, `${pathHash}/`);
  }

  private getOutputNames(digester: Digester): string[] {
    const outputs = digester.getOutputDigesters?.();
    if (outputs && outputs.length > 0) {
      return outputs;
    }
    return [digester.name];
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
      const id = generateDigestId(filePath, name);
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
