/**
 * People API - Merge Operations
 *
 * POST /api/people/[id]/merge - Merge source person into this (target) person
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPersonById, mergePeople } from '@/lib/db/people';
import { getLogger } from '@/lib/log/logger';

export const runtime = 'nodejs';

const log = getLogger({ module: 'ApiPeopleMerge' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/people/[id]/merge
 * Merge another person (source) into this person (target)
 *
 * All clusters from the source person are moved to the target.
 * The source person is deleted after merge.
 *
 * Request body:
 * - sourceId: string (ID of person to merge into this one)
 */
export async function POST(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id: targetId } = await context.params;
    const body = await request.json();
    const { sourceId } = body;

    if (!sourceId || typeof sourceId !== 'string') {
      return NextResponse.json(
        { error: 'sourceId is required' },
        { status: 400 }
      );
    }

    // Validate both people exist
    const target = getPersonById(targetId);
    const source = getPersonById(sourceId);

    if (!target) {
      return NextResponse.json(
        { error: 'Target person not found' },
        { status: 404 }
      );
    }

    if (!source) {
      return NextResponse.json(
        { error: 'Source person not found' },
        { status: 404 }
      );
    }

    if (targetId === sourceId) {
      return NextResponse.json(
        { error: 'Cannot merge person with itself' },
        { status: 400 }
      );
    }

    // Perform merge
    const mergedPerson = mergePeople(targetId, sourceId);

    log.info(
      {
        targetId,
        sourceId,
        targetName: target.displayName,
        sourceName: source.displayName,
      },
      'merged people'
    );

    return NextResponse.json(mergedPerson);
  } catch (error) {
    log.error({ err: error }, 'merge people failed');
    return NextResponse.json(
      { error: 'Failed to merge people' },
      { status: 500 }
    );
  }
}
