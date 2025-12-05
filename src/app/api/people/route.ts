/**
 * People API - List and Create
 *
 * GET  /api/people - List all people (identified first, then pending)
 * POST /api/people - Create a new identified people entry with name
 */

import { NextRequest, NextResponse } from 'next/server';
import { listPeopleWithCounts, createPeople, countPeople } from '@/lib/db/people';
import { getLogger } from '@/lib/log/logger';

export const runtime = 'nodejs';

const log = getLogger({ module: 'ApiPeople' });

/**
 * GET /api/people
 * List all people with cluster/embedding counts
 *
 * Query params:
 * - pending: 'true' to show only pending people
 * - identified: 'true' to show only identified people
 * - limit: number of results (default 100)
 * - offset: pagination offset (default 0)
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const pendingOnly = searchParams.get('pending') === 'true';
    const identifiedOnly = searchParams.get('identified') === 'true';
    const limit = parseInt(searchParams.get('limit') ?? '100', 10);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10);

    const people = listPeopleWithCounts({
      pendingOnly,
      identifiedOnly,
      limit,
      offset,
    });

    const total = countPeople({ pendingOnly, identifiedOnly });

    return NextResponse.json({
      people,
      total,
      limit,
      offset,
    });
  } catch (error) {
    log.error({ err: error }, 'list people failed');
    return NextResponse.json(
      { error: 'Failed to list people' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/people
 * Create a new identified people entry with a name
 *
 * Request body:
 * - displayName: string (required)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { displayName } = body;

    if (!displayName || typeof displayName !== 'string') {
      return NextResponse.json(
        { error: 'displayName is required' },
        { status: 400 }
      );
    }

    // Create people entry - vcfPath will be set when vCard is created
    const people = createPeople({
      displayName: displayName.trim(),
    });

    log.info({ peopleId: people.id, displayName }, 'created people');

    return NextResponse.json(people, { status: 201 });
  } catch (error) {
    log.error({ err: error }, 'create people failed');
    return NextResponse.json(
      { error: 'Failed to create people' },
      { status: 500 }
    );
  }
}
