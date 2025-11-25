import { NextResponse } from 'next/server';
import { dbSelectOne } from '@/lib/db/client';

export async function GET() {
  try {
    // Get library files count (including inbox, excluding app folder)
    const libraryFiles = dbSelectOne<{ count: number; totalSize: number }>(
      `SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as totalSize
       FROM files
       WHERE is_folder = 0
       AND path NOT LIKE 'app/%'`
    );

    // Get inbox items count (subset of library)
    const inboxItems = dbSelectOne<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM files
       WHERE is_folder = 0
       AND path LIKE 'inbox/%'`
    );

    // Get digest stats
    const totalFiles = dbSelectOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM files
       WHERE is_folder = 0
       AND path NOT LIKE 'app/%'`
    );

    const digestedFiles = dbSelectOne<{ count: number }>(
      `SELECT COUNT(DISTINCT file_path) as count FROM digests
       WHERE status = 'completed'
       AND file_path NOT LIKE 'app/%'`
    );

    const pendingDigests = dbSelectOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM digests
       WHERE status IN ('todo', 'in-progress')
       AND file_path NOT LIKE 'app/%'`
    );

    return NextResponse.json({
      library: {
        fileCount: libraryFiles?.count ?? 0,
        totalSize: libraryFiles?.totalSize ?? 0,
      },
      inbox: {
        itemCount: inboxItems?.count ?? 0,
      },
      digests: {
        totalFiles: totalFiles?.count ?? 0,
        digestedFiles: digestedFiles?.count ?? 0,
        pendingDigests: pendingDigests?.count ?? 0,
      },
    });
  } catch (error) {
    console.error('Failed to get stats:', error);
    return NextResponse.json(
      { error: 'Failed to get stats' },
      { status: 500 }
    );
  }
}
