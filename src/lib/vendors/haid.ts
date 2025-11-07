import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'VendorHAID' });

export interface HaidEmbeddingOptions {
  texts: string[];
  model?: string;
}

const DEFAULT_MODEL = 'Qwen/Qwen3-Embedding-0.6B';

export interface HaidEmbeddingResponse {
  embeddings: number[][];
  model: string;
  dimensions: number;
}

export async function callHaidEmbedding(
  options: HaidEmbeddingOptions
): Promise<HaidEmbeddingResponse> {
  if (!options.texts || options.texts.length === 0) {
    throw new Error('HAID embedding requires at least one text');
  }

  const baseUrl = process.env.HAID_BASE_URL || 'http://172.16.2.11:12310';
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/text-to-embedding`;
  const apiKey = process.env.HAID_API_KEY;
  const model =
    options.model ||
    process.env.HAID_EMBEDDING_MODEL ||
    DEFAULT_MODEL;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      texts: options.texts,
      model,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HAID embedding error (${response.status}): ${errorText || response.statusText}`
    );
  }

  const data = await response.json();
  const embeddings = extractEmbeddings(data);
  if (!embeddings.length) {
    throw new Error('HAID embedding response did not include embeddings');
  }

  const dimensions =
    data.dimensions ??
    (embeddings[0] ? embeddings[0].length : 0);

  return {
    embeddings,
    model: data.model ?? model,
    dimensions,
  };
}

function extractEmbeddings(payload: any): number[][] {
  if (Array.isArray(payload?.embeddings)) {
    return payload.embeddings as number[][];
  }

  if (Array.isArray(payload?.vectors)) {
    return payload.vectors as number[][];
  }

  if (Array.isArray(payload?.data)) {
    return payload.data
      .map((item: any) => item?.embedding)
      .filter((embedding: unknown): embedding is number[] => Array.isArray(embedding));
  }

  log.warn({ payload }, 'unable to detect embeddings array in HAID response');
  return [];
}
