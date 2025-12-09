import { getLogger } from '~/lib/log/logger';
import { loadSettings } from '~/lib/config/storage';

const log = getLogger({ module: 'QdrantClient' });

interface QdrantClientConfig {
  url: string;
  apiKey?: string;
  collection: string;
  requestTimeoutMs: number;
}

interface QdrantUpsertResponse {
  result: { operation_id?: number; status?: string };
}

interface QdrantDeleteResponse {
  result: { status?: string };
}

interface QdrantSearchParams {
  vector: number[];
  limit: number;
  scoreThreshold?: number;
  filter?: Record<string, unknown>;
  withPayload?: boolean;
}

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

class QdrantClient {
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly collection: string;
  private readonly timeoutMs: number;

  constructor(config: QdrantClientConfig) {
    this.url = config.url.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.collection = config.collection;
    this.timeoutMs = config.requestTimeoutMs;
  }

  async upsert(points: QdrantPoint[]): Promise<void> {
    if (points.length === 0) return;

    await this.request<QdrantUpsertResponse>(
      `/collections/${encodeURIComponent(this.collection)}/points?wait=true`,
      {
        method: 'PUT',
        body: JSON.stringify({ points }),
      }
    );
  }

  async delete(pointsIds: string[]): Promise<void> {
    if (pointsIds.length === 0) return;

    await this.request<QdrantDeleteResponse>(
      `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
      {
        method: 'POST',
        body: JSON.stringify({ points: pointsIds }),
      }
    );
  }

  async deleteAll(): Promise<void> {
    // Delete all points using filter that matches all (empty filter matches everything)
    await this.request<QdrantDeleteResponse>(
      `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
      {
        method: 'POST',
        body: JSON.stringify({
          filter: {
            must: []  // Empty filter matches all points
          }
        }),
      }
    );
  }

  async search(params: QdrantSearchParams): Promise<unknown> {
    return this.request(
      `/collections/${encodeURIComponent(this.collection)}/points/search`,
      {
        method: 'POST',
        body: JSON.stringify({
          vector: params.vector,
          limit: params.limit,
          score_threshold: params.scoreThreshold,
          filter: params.filter,
          with_payload: params.withPayload ?? true,
        }),
      }
    );
  }

  async ensureCollection(vectorSize: number): Promise<void> {
    try {
      // Check if collection exists
      await this.request(`/collections/${encodeURIComponent(this.collection)}`, {
        method: 'GET',
      });
      log.debug({ collection: this.collection }, 'collection already exists');
    } catch {
      // Collection doesn't exist, create it
      log.info({ collection: this.collection, vectorSize }, 'creating collection');
      await this.request(`/collections/${encodeURIComponent(this.collection)}`, {
        method: 'PUT',
        body: JSON.stringify({
          vectors: {
            size: vectorSize,
            distance: 'Cosine',
          },
        }),
      });
      log.info({ collection: this.collection }, 'collection created');
    }
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.url}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
          ...init.headers,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Qdrant request failed (${response.status}): ${errorText}`);
      }

      if (response.status === 204) {
        return {} as T;
      }

      return (await response.json()) as T;
    } catch (error) {
      log.error({ err: error, path }, 'qdrant request failed');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

let cachedClient: QdrantClient | null = null;

export async function getQdrantClient(): Promise<QdrantClient> {
  if (cachedClient) return cachedClient;

  // Try loading from vendor settings first
  let url: string | undefined;
  try {
    const settings = await loadSettings();
    url = settings.vendors?.qdrant?.host;
  } catch (error) {
    log.warn({ err: error }, 'failed to load Qdrant host from settings');
  }

  // Fall back to environment variable if not in settings
  if (!url) {
    url = process.env.QDRANT_URL;
  }

  if (!url) {
    throw new Error('QDRANT_URL is not configured (check settings.vendors.qdrant.host or QDRANT_URL env var)');
  }

  const collection = process.env.QDRANT_COLLECTION || 'mylifedb_vectors';
  const apiKey = process.env.QDRANT_API_KEY;
  const timeoutMs = Number(process.env.QDRANT_REQUEST_TIMEOUT_MS ?? 30_000);

  cachedClient = new QdrantClient({
    url,
    apiKey,
    collection,
    requestTimeoutMs: timeoutMs,
  });

  log.info({ url, collection }, 'initialized Qdrant client');
  return cachedClient;
}

/**
 * Ensure Qdrant collection exists
 * Call this during app initialization or before first use
 */
export async function ensureQdrantCollection(vectorSize = 1024): Promise<void> {
  const client = await getQdrantClient();
  await client.ensureCollection(vectorSize);
}
