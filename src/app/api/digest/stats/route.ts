import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db/connection';

export async function GET() {
  try {
    const db = getDatabase();

    // Count total files (excluding folders and app/ directory)
    const totalFiles = db
      .prepare(
        `SELECT COUNT(*) as count FROM files
         WHERE is_folder = 0
         AND path NOT LIKE 'app/%'`
      )
      .get() as { count: number };

    // Count files with at least one completed digest
    const digestedFiles = db
      .prepare(
        `SELECT COUNT(DISTINCT file_path) as count FROM digests
         WHERE status = 'completed'
         AND file_path NOT LIKE 'app/%'`
      )
      .get() as { count: number };

    // Count pending digests
    const pendingDigests = db
      .prepare(
        `SELECT COUNT(*) as count FROM digests
         WHERE status = 'pending'
         AND file_path NOT LIKE 'app/%'`
      )
      .get() as { count: number };

    return NextResponse.json({
      totalFiles: totalFiles.count,
      digestedFiles: digestedFiles.count,
      pendingDigests: pendingDigests.count,
    });
  } catch (error) {
    console.error('Failed to get digest stats:', error);
    return NextResponse.json(
      { error: 'Failed to get digest stats' },
      { status: 500 }
    );
  }
}
