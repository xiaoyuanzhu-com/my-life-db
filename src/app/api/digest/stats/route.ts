import { NextResponse } from 'next/server';
import { getDigestStats } from '@/lib/db/digests';

export async function GET() {
  try {
    const stats = getDigestStats();

    return NextResponse.json(stats);
  } catch (error) {
    console.error('Failed to get digest stats:', error);
    return NextResponse.json(
      { error: 'Failed to get digest stats' },
      { status: 500 }
    );
  }
}
