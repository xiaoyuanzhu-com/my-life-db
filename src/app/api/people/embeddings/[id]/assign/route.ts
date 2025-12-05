/**
 * Embedding API - Assign Operations
 *
 * POST /api/people/embeddings/[id]/assign - Manually assign embedding to a person
 */

import { NextRequest, NextResponse } from 'next/server';
import { getEmbeddingById, getPersonById, assignEmbeddingToPerson } from '@/lib/db/people';
import { getLogger } from '@/lib/log/logger';

export const runtime = 'nodejs';

const log = getLogger({ module: 'ApiEmbeddingAssign' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/people/embeddings/[id]/assign
 * Manually assign an embedding to a person
 *
 * This is a manual override that sets manualAssignment = true,
 * preventing the embedding from being auto-clustered in the future.
 *
 * Request body:
 * - personId: string (ID of person to assign embedding to)
 */
export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id: embeddingId } = await context.params;
    const body = await request.json();
    const { personId } = body;

    if (!personId || typeof personId !== 'string') {
      return NextResponse.json(
        { error: 'personId is required' },
        { status: 400 }
      );
    }

    // Validate embedding exists
    const embedding = getEmbeddingById(embeddingId);
    if (!embedding) {
      return NextResponse.json(
        { error: 'Embedding not found' },
        { status: 404 }
      );
    }

    // Validate person exists
    const person = getPersonById(personId);
    if (!person) {
      return NextResponse.json(
        { error: 'Person not found' },
        { status: 404 }
      );
    }

    // Assign embedding to person
    const result = assignEmbeddingToPerson(embeddingId, personId);

    log.info(
      {
        embeddingId,
        personId,
        clusterId: result.cluster.id,
        personName: person.displayName,
      },
      'assigned embedding to person'
    );

    return NextResponse.json({
      embedding: {
        ...result.embedding,
        vector: undefined, // Don't send vector to client
      },
      cluster: {
        ...result.cluster,
        centroid: undefined, // Don't send centroid to client
      },
    });
  } catch (error) {
    log.error({ err: error }, 'assign embedding failed');
    return NextResponse.json(
      { error: 'Failed to assign embedding' },
      { status: 500 }
    );
  }
}
