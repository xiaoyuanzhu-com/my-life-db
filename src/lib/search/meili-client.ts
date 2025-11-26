import 'server-only';
import { getLogger } from '@/lib/log/logger';
import { getSettings } from '@/lib/config/storage';
import type { MeilisearchDocumentPayload } from './types';

const log = getLogger({ module: 'MeiliClient' });

interface MeiliClientConfig {
  host: string;
  apiKey?: string;
  indexUid: string;
  requestTimeoutMs: number;
}

interface MeiliTask {
  taskUid: number;
  status: 'enqueued' | 'processing' | 'succeeded' | 'failed';
  error?: { message?: string } | null;
}

interface MeiliIndex {
  uid: string;
  primaryKey: string;
  createdAt: string;
  updatedAt: string;
}

interface MeiliIndexSettings {
  rankingRules?: string[];
  searchableAttributes?: string[];
  filterableAttributes?: string[];
  sortableAttributes?: string[];
  displayedAttributes?: string[];
}

class MeiliClient {
  private readonly host: string;
  private readonly apiKey?: string;
  private readonly indexUid: string;
  private readonly timeoutMs: number;

  constructor(config: MeiliClientConfig) {
    this.host = config.host.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.indexUid = config.indexUid;
    this.timeoutMs = config.requestTimeoutMs;
  }

  async addDocuments(documents: MeilisearchDocumentPayload[]): Promise<number> {
    const response = await this.request<{ taskUid: number }>(
      `/indexes/${encodeURIComponent(this.indexUid)}/documents`,
      {
        method: 'POST',
        body: JSON.stringify(documents),
      }
    );
    return response.taskUid;
  }

  async deleteDocuments(documentIds: string[]): Promise<number> {
    if (documentIds.length === 0) return 0;
    const response = await this.request<{ taskUid: number }>(
      `/indexes/${encodeURIComponent(this.indexUid)}/documents/delete-batch`,
      {
        method: 'POST',
        body: JSON.stringify(documentIds),
      }
    );
    return response.taskUid;
  }

  async deleteAllDocuments(): Promise<number> {
    const response = await this.request<{ taskUid: number }>(
      `/indexes/${encodeURIComponent(this.indexUid)}/documents`,
      {
        method: 'DELETE',
      }
    );
    return response.taskUid;
  }

  async search<T = unknown>(
    query: string,
    options?: {
      limit?: number;
      offset?: number;
      filter?: string;
      sort?: string[];
      attributesToRetrieve?: string[];
      attributesToHighlight?: string[];
      attributesToCrop?: string[];
      cropLength?: number;
      highlightPreTag?: string;
      highlightPostTag?: string;
      matchingStrategy?: 'all' | 'last';
    }
  ): Promise<{
    hits: T[];
    query: string;
    processingTimeMs: number;
    limit: number;
    offset: number;
    estimatedTotalHits: number;
  }> {
    const response = await this.request<{
      hits: T[];
      query: string;
      processingTimeMs: number;
      limit: number;
      offset: number;
      estimatedTotalHits: number;
    }>(
      `/indexes/${encodeURIComponent(this.indexUid)}/search`,
      {
        method: 'POST',
        body: JSON.stringify({
          q: query,
          limit: options?.limit ?? 20,
          offset: options?.offset ?? 0,
          filter: options?.filter,
          sort: options?.sort,
          attributesToRetrieve: options?.attributesToRetrieve ?? ['*'],
          attributesToHighlight: options?.attributesToHighlight,
          attributesToCrop: options?.attributesToCrop,
          cropLength: options?.cropLength ?? 200,
          highlightPreTag: options?.highlightPreTag ?? '<em>',
          highlightPostTag: options?.highlightPostTag ?? '</em>',
          matchingStrategy: options?.matchingStrategy ?? 'all',
        }),
      }
    );
    return response;
  }

  async waitForTask(taskUid: number, options?: { timeoutMs?: number; intervalMs?: number }): Promise<MeiliTask> {
    const timeoutMs = options?.timeoutMs ?? 60_000;
    const intervalMs = options?.intervalMs ?? 1_000;
    const startedAt = Date.now();

    while (true) {
      const task = await this.request<MeiliTask>(`/tasks/${taskUid}`, { method: 'GET' });

      if (task.status === 'succeeded' || task.status === 'failed') {
        return task;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Meilisearch task ${taskUid} timed out after ${timeoutMs}ms`);
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  async getIndex(): Promise<MeiliIndex | null> {
    try {
      return await this.request<MeiliIndex>(
        `/indexes/${encodeURIComponent(this.indexUid)}`,
        { method: 'GET' }
      );
    } catch (error) {
      // Index doesn't exist
      if ((error as Error).message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  async createIndex(primaryKey: string = 'documentId'): Promise<number> {
    const response = await this.request<{ taskUid: number }>(
      '/indexes',
      {
        method: 'POST',
        body: JSON.stringify({
          uid: this.indexUid,
          primaryKey,
        }),
      }
    );
    return response.taskUid;
  }

  async updateIndexSettings(settings: MeiliIndexSettings): Promise<number> {
    const response = await this.request<{ taskUid: number }>(
      `/indexes/${encodeURIComponent(this.indexUid)}/settings`,
      {
        method: 'PATCH',
        body: JSON.stringify(settings),
      }
    );
    return response.taskUid;
  }

  async getIndexSettings(): Promise<MeiliIndexSettings> {
    return await this.request<MeiliIndexSettings>(
      `/indexes/${encodeURIComponent(this.indexUid)}/settings`,
      { method: 'GET' }
    );
  }

  async ensureIndex(): Promise<void> {
    const index = await this.getIndex();

    if (!index) {
      log.info({ indexUid: this.indexUid }, 'creating Meilisearch index');
      const taskUid = await this.createIndex('documentId');
      const task = await this.waitForTask(taskUid, { timeoutMs: 30_000 });

      if (task.status !== 'succeeded') {
        throw new Error(`Failed to create index: ${task.error?.message ?? 'unknown error'}`);
      }

      log.info({ indexUid: this.indexUid }, 'Meilisearch index created');
    }

    // Configure index settings
    await this.configureIndexSettings();
  }

  private async configureIndexSettings(): Promise<void> {
    const desiredSettings: MeiliIndexSettings = {
      rankingRules: [
        'words',
        'typo',
        'proximity',
        'attribute',
        'sort',
        'exactness',
      ],
      searchableAttributes: [
        'content',   // Main file content (highest priority)
        'summary',   // AI-generated summary
        'tags',      // Tags from digest
        'filePath',  // File path for exact matches
        'metadata.title',
        'metadata.description',
        'metadata.author',
        'metadata.url',
        'metadata.hostname',
      ],
      filterableAttributes: [
        'filePath',     // Filter by file path
        'mimeType',     // Filter by MIME type (e.g., text/markdown, image/jpeg)
        'contentHash',  // For deduplication
        'metadata.tags',
        'metadata.hostname',
        'createdAt',
        'updatedAt',
      ],
      sortableAttributes: [
        'createdAt',
        'updatedAt',
        'wordCount',
        'metadata.durationSeconds', // For audio/video
      ],
    };

    try {
      const currentSettings = await this.getIndexSettings();

      // Check if settings need updating
      const needsUpdate =
        JSON.stringify(currentSettings.rankingRules) !== JSON.stringify(desiredSettings.rankingRules) ||
        JSON.stringify(currentSettings.searchableAttributes) !== JSON.stringify(desiredSettings.searchableAttributes) ||
        JSON.stringify(currentSettings.filterableAttributes) !== JSON.stringify(desiredSettings.filterableAttributes) ||
        JSON.stringify(currentSettings.sortableAttributes) !== JSON.stringify(desiredSettings.sortableAttributes);

      if (needsUpdate) {
        log.info({ indexUid: this.indexUid }, 'updating Meilisearch index settings');
        const taskUid = await this.updateIndexSettings(desiredSettings);
        const task = await this.waitForTask(taskUid, { timeoutMs: 30_000 });

        if (task.status !== 'succeeded') {
          log.warn(
            { error: task.error?.message },
            'failed to update index settings, continuing anyway'
          );
        } else {
          log.info({ indexUid: this.indexUid }, 'Meilisearch index settings updated');
        }
      }
    } catch (error) {
      log.warn(
        { err: error, indexUid: this.indexUid },
        'failed to configure index settings, continuing anyway'
      );
    }
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.host}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...init.headers,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Meilisearch request failed (${response.status} ${response.statusText}): ${errorText}`
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      log.error({ err: error, path }, 'meilisearch request failed');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

let cachedClient: MeiliClient | null = null;
let indexEnsured = false;

export async function getMeiliClient(): Promise<MeiliClient> {
  if (cachedClient) return cachedClient;

  let host = process.env.MEILI_HOST;

  // Try loading from vendor settings if not in environment
  if (!host) {
    try {
      const settings = await getSettings();
      host = settings.vendors?.meilisearch?.host;
    } catch (error) {
      log.warn({ err: error }, 'failed to load Meilisearch host from settings');
    }
  }

  if (!host) {
    throw new Error('MEILI_HOST is not configured');
  }

  const indexUid = process.env.MEILI_INDEX || 'mylifedb_files';
  const apiKey = process.env.MEILI_API_KEY;
  const timeoutMs = Number(process.env.MEILI_REQUEST_TIMEOUT_MS ?? 30_000);

  cachedClient = new MeiliClient({
    host,
    indexUid,
    apiKey,
    requestTimeoutMs: timeoutMs,
  });

  log.info(
    { host, indexUid },
    'initialized Meilisearch client'
  );

  // Ensure index exists on first access
  if (!indexEnsured) {
    try {
      await cachedClient.ensureIndex();
      indexEnsured = true;
    } catch (error) {
      log.error({ err: error }, 'failed to ensure Meilisearch index exists');
      // Don't throw - allow the client to be used, operations will fail gracefully
    }
  }

  return cachedClient;
}
