/**
 * People API - Individual Person Operations
 *
 * GET    /api/people/[id] - Get person with clusters and embeddings
 * PUT    /api/people/[id] - Update person name (creates vCard if pending)
 * DELETE /api/people/[id] - Delete person, clusters, and vCard
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getPersonById,
  updatePerson,
  deletePerson,
  listClustersForPerson,
  listEmbeddingsForPerson,
} from '@/lib/db/people';
import { getLogger } from '@/lib/log/logger';

export const runtime = 'nodejs';

const log = getLogger({ module: 'ApiPeopleById' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/people/[id]
 * Get person details with linked clusters and embeddings
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const person = getPersonById(id);

    if (!person) {
      return NextResponse.json(
        { error: 'Person not found' },
        { status: 404 }
      );
    }

    // Get clusters and embeddings
    const voiceClusters = listClustersForPerson(id, 'voice');
    const faceClusters = listClustersForPerson(id, 'face');
    const voiceEmbeddings = listEmbeddingsForPerson(id, 'voice');
    const faceEmbeddings = listEmbeddingsForPerson(id, 'face');

    return NextResponse.json({
      ...person,
      clusters: {
        voice: voiceClusters,
        face: faceClusters,
      },
      embeddings: {
        voice: voiceEmbeddings.map((e) => ({
          ...e,
          // Convert Float32Array to regular array for JSON serialization
          vector: undefined, // Don't send vectors to client
        })),
        face: faceEmbeddings.map((e) => ({
          ...e,
          vector: undefined,
        })),
      },
    });
  } catch (error) {
    log.error({ err: error }, 'get person failed');
    return NextResponse.json(
      { error: 'Failed to get person' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/people/[id]
 * Update person name
 *
 * For pending people (no vcfPath), this sets the display name.
 * In a full implementation, this would also create the vCard file.
 *
 * Request body:
 * - displayName: string (required)
 */
export async function PUT(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const person = getPersonById(id);

    if (!person) {
      return NextResponse.json(
        { error: 'Person not found' },
        { status: 404 }
      );
    }

    const body = await request.json();
    const { displayName } = body;

    if (!displayName || typeof displayName !== 'string') {
      return NextResponse.json(
        { error: 'displayName is required' },
        { status: 400 }
      );
    }

    // Update display name
    const updatedPerson = updatePerson(id, {
      displayName: displayName.trim(),
    });

    // TODO: In Phase 2, create/update vCard file here
    // For now, we just update the database

    log.info({ personId: id, displayName }, 'updated person');

    return NextResponse.json(updatedPerson);
  } catch (error) {
    log.error({ err: error }, 'update person failed');
    return NextResponse.json(
      { error: 'Failed to update person' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/people/[id]
 * Delete person, their clusters, and orphan their embeddings
 *
 * Note: Embeddings are not deleted - they become orphaned (cluster_id = NULL)
 * and can be reassigned to another person.
 */
export async function DELETE(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const person = getPersonById(id);

    if (!person) {
      return NextResponse.json(
        { error: 'Person not found' },
        { status: 404 }
      );
    }

    // TODO: In Phase 2, delete vCard file if exists
    // if (person.vcfPath) {
    //   await deleteVCardFile(person.vcfPath);
    // }

    // Delete person (cascades to clusters, embeddings become orphaned)
    deletePerson(id);

    log.info({ personId: id, displayName: person.displayName }, 'deleted person');

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'delete person failed');
    return NextResponse.json(
      { error: 'Failed to delete person' },
      { status: 500 }
    );
  }
}
