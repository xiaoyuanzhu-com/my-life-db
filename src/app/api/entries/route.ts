// API route for entries
import { NextRequest, NextResponse } from 'next/server';
import { createEntry, listEntries } from '@/lib/fs/storage';
import { z } from 'zod';

const CreateEntrySchema = z.object({
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const directory = searchParams.get('directory') || 'inbox';

    const entries = await listEntries(directory);

    return NextResponse.json({ entries, total: entries.length });
  } catch (error) {
    console.error('Error fetching entries:', error);
    return NextResponse.json(
      { error: 'Failed to fetch entries' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validated = CreateEntrySchema.parse(body);

    const entry = await createEntry(validated.content, validated.tags);

    return NextResponse.json(entry, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.errors },
        { status: 400 }
      );
    }

    console.error('Error creating entry:', error);
    return NextResponse.json(
      { error: 'Failed to create entry' },
      { status: 500 }
    );
  }
}
