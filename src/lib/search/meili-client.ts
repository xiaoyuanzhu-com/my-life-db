import 'server-only';
import { getLogger } from '@/lib/log/logger';
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

export function getMeiliClient(): MeiliClient {
  if (cachedClient) return cachedClient;

  const host = process.env.MEILI_HOST;
  if (!host) {
    throw new Error('MEILI_HOST is not configured');
  }

  const indexUid = process.env.MEILI_INDEX_URL_CONTENT || 'url_content';
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

  return cachedClient;
}
