/**
 * Embedding API - Assign Operations
 *
 * POST /api/people/embeddings/[id]/assign - Manually assign embedding to a people entry
 */

import { NextRequest, NextResponse } from 'next/server';
import { getEmbeddingById, getPeopleById, assignEmbeddingToPeople } from '@/lib/db/people';
import { getLogger } from '@/lib/log/logger';

export const runtime = 'nodejs';

const log = getLogger({ module: 'ApiEmbeddingAssign' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/people/embeddings/[id]/assign
 * Manually assign an embedding to a people entry
 *
 * This is a manual override that sets manualAssignment = true,
 * preventing the embedding from being auto-clustered in the future.
 *
 * Request body:
 * - peopleId: string (ID of people to assign embedding to)
 */
export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id: embeddingId } = await context.params;
    const body = await request.json();
    const { peopleId } = body;

    if (!peopleId || typeof peopleId !== 'string') {
      return NextResponse.json(
        { error: 'peopleId is required' },
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

    // Validate people exists
    const people = getPeopleById(peopleId);
    if (!people) {
      return NextResponse.json(
        { error: 'People not found' },
        { status: 404 }
      );
    }

    // Assign embedding to people
    const result = assignEmbeddingToPeople(embeddingId, peopleId);

    log.info(
      {
        embeddingId,
        peopleId,
        clusterId: result.cluster.id,
        peopleName: people.displayName,
      },
      'assigned embedding to people'
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
