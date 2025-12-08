import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { globalDigesterRegistry } from '@/lib/digest/registry';
import { initializeDigesters } from '@/lib/digest/initialization';

/**
 * GET /api/digest/digesters
 *
 * Returns list of registered digesters with their metadata
 */
export async function GET() {
  // Ensure digesters are initialized
  initializeDigesters();

  const digesters = globalDigesterRegistry.getDigesterInfo();

  return NextResponse.json({ digesters });
}
