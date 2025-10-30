// API route for search
import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';
import { searchEntries } from '@/lib/fs/storage';
import { getLogger } from '@/lib/log/logger';

const log = getLogger({ module: 'ApiSearch' });

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('q') || '';
    const limit = parseInt(searchParams.get('limit') || '50');

    if (!query) {
      return NextResponse.json(
        { error: 'Query parameter required' },
        { status: 400 }
      );
    }

    const results = await searchEntries(query, limit);

    return NextResponse.json({
      results,
      total: results.length,
      query,
    });
  } catch (error) {
    log.error({ err: error }, 'search entries failed');
    return NextResponse.json(
      { error: 'Failed to search entries' },
      { status: 500 }
    );
  }
}
