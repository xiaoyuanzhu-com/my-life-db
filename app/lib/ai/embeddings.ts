import 'server-only';
import { callHaidEmbedding } from '@/lib/vendors/haid';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'Embeddings' });

export interface EmbeddingVector {
  vector: number[];
  model: string;
  dimensions: number;
}

export async function embedText(text: string): Promise<EmbeddingVector> {
  const [vector] = await embedTexts([text]);
  if (!vector) {
    throw new Error('Embedding generation returned no data');
  }
  return vector;
}

export async function embedTexts(texts: string[], options?: { model?: string }): Promise<EmbeddingVector[]> {
  const cleanTexts = texts.map(text => text?.trim() ?? '').filter(Boolean);
  if (cleanTexts.length === 0) return [];

  try {
    const response = await callHaidEmbedding({
      texts: cleanTexts,
      model: options?.model,
    });

    return response.embeddings.map((embedding) => ({
      vector: embedding,
      model: response.model,
      dimensions: response.dimensions || embedding.length,
    }));
  } catch (error) {
    log.error({ err: error }, 'HAID embedding generation failed');
    throw error;
  }
}
