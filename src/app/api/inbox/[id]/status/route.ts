import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'nodejs';

import { getInboxStatusView } from '@/lib/inbox/statusView';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const view = getInboxStatusView(id);
    if (!view) {
      return NextResponse.json({ error: 'Inbox item not found' }, { status: 404 });
    }
    return NextResponse.json(view);
  } catch (error) {
    console.error('Error building inbox status view:', error);
    return NextResponse.json({ error: 'Failed to get inbox status' }, { status: 500 });
  }
}

