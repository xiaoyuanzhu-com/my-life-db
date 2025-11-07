import 'server-only';
import { callOpenAIEmbedding } from '@/lib/vendors/openai';
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

export async function embedTexts(texts: string[]): Promise<EmbeddingVector[]> {
  const cleanTexts = texts.map(text => text?.trim() ?? '').filter(Boolean);
  if (cleanTexts.length === 0) return [];

  try {
    const response = await callOpenAIEmbedding({ input: cleanTexts });
    return response.embeddings.map((embedding, index) => ({
      vector: embedding,
      model: response.model,
      dimensions: embedding.length,
    }));
  } catch (error) {
    log.error({ err: error }, 'embedding generation failed');
    throw error;
  }
}
