// API route for search
import { NextRequest, NextResponse } from 'next/server';
import { searchEntries } from '@/lib/fs/storage';

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
    console.error('Error searching entries:', error);
    return NextResponse.json(
      { error: 'Failed to search entries' },
      { status: 500 }
    );
  }
}
