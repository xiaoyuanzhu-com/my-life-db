import { NextRequest, NextResponse } from 'next/server';
import { getFileByPath } from '@/lib/db/files';
import { listDigestsForPath } from '@/lib/db/digests';

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const decodePathParam = (value: string): string => {
  const once = safeDecodeURIComponent(value);
  return /%[0-9A-Fa-f]{2}/.test(once) ? safeDecodeURIComponent(once) : once;
};

/**
 * GET /api/library/file-info?path=<file-path>
 *
 * Get file metadata and all digests for a file
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const rawPath = searchParams.get('path');
    const filePath = rawPath ? decodePathParam(rawPath) : null;

    if (!filePath) {
      return NextResponse.json(
        { error: 'Missing path parameter' },
        { status: 400 }
      );
    }

    // Get file metadata from database
    const fileRecord = getFileByPath(filePath);

    if (!fileRecord) {
      return NextResponse.json(
        { error: 'File not found in database' },
        { status: 404 }
      );
    }

    // Get all digests for this file
    const digests = listDigestsForPath(filePath, {
      order: 'asc',
      excludeStatuses: ['skipped'],
      excludeDigesters: ['url-crawl'],
    });

    return NextResponse.json({
      file: fileRecord,
      digests: digests,
    });
  } catch (error) {
    console.error('Error fetching file info:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
