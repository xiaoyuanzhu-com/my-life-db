/**
 * Embedding API - Unassign Operations
 *
 * POST /api/people/embeddings/[id]/unassign - Unassign embedding from its current person/cluster
 */

import { NextRequest, NextResponse } from 'next/server';
import { getEmbeddingById, unassignEmbedding } from '@/lib/db/people';
import { getLogger } from '@/lib/log/logger';

export const runtime = 'nodejs';

const log = getLogger({ module: 'ApiEmbeddingUnassign' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/people/embeddings/[id]/unassign
 * Unassign an embedding from its current person/cluster
 *
 * The embedding will have:
 * - cluster_id set to NULL
 * - manual_assignment set to TRUE (won't be auto-clustered again)
 *
 * If the cluster becomes empty after removal, it will be deleted.
 * If the person has no clusters left and is pending (no name), they will be deleted.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id: embeddingId } = await context.params;

    // Validate embedding exists
    const embedding = getEmbeddingById(embeddingId);
    if (!embedding) {
      return NextResponse.json(
        { error: 'Embedding not found' },
        { status: 404 }
      );
    }

    // Store cluster info for logging
    const previousClusterId = embedding.clusterId;

    // Unassign embedding
    unassignEmbedding(embeddingId);

    // Get updated embedding
    const updatedEmbedding = getEmbeddingById(embeddingId);

    log.info(
      {
        embeddingId,
        previousClusterId,
      },
      'unassigned embedding from cluster'
    );

    return NextResponse.json({
      embedding: updatedEmbedding ? {
        ...updatedEmbedding,
        vector: undefined, // Don't send vector to client
      } : null,
    });
  } catch (error) {
    log.error({ err: error }, 'unassign embedding failed');
    return NextResponse.json(
      { error: 'Failed to unassign embedding' },
      { status: 500 }
    );
  }
}
