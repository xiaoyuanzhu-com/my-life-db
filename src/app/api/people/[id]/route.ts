/**
 * People API - Individual People Operations
 *
 * GET    /api/people/[id] - Get people entry with clusters and embeddings
 * PUT    /api/people/[id] - Update people name (creates vCard if pending)
 * DELETE /api/people/[id] - Delete people entry, clusters, and vCard
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getPeopleById,
  updatePeople,
  deletePeople,
  listClustersForPeople,
  listEmbeddingsForPeople,
} from '@/lib/db/people';
import { getDigestByPathAndDigester } from '@/lib/db/digests';
import { getLogger } from '@/lib/log/logger';
import type { VoiceSourceOffset } from '@/types/people-embedding';

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}

interface SpeechRecognitionContent {
  text: string;
  language: string;
  segments: TranscriptSegment[];
}

interface VoiceSegmentWithText {
  start: number;
  end: number;
  text: string;
}

export const runtime = 'nodejs';

const log = getLogger({ module: 'ApiPeopleById' });

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/people/[id]
 * Get people details with linked clusters and embeddings
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const people = getPeopleById(id);

    if (!people) {
      return NextResponse.json(
        { error: 'People not found' },
        { status: 404 }
      );
    }

    // Get clusters and embeddings
    const voiceClusters = listClustersForPeople(id, 'voice');
    const faceClusters = listClustersForPeople(id, 'face');
    const voiceEmbeddings = listEmbeddingsForPeople(id, 'voice');
    const faceEmbeddings = listEmbeddingsForPeople(id, 'face');

    // Collect unique source paths to fetch transcripts
    const sourcePaths = [...new Set(voiceEmbeddings.map((e) => e.sourcePath))];

    // Fetch speech-recognition digests for all source files
    const transcriptsByPath = new Map<string, TranscriptSegment[]>();
    for (const sourcePath of sourcePaths) {
      const digest = getDigestByPathAndDigester(sourcePath, 'speech-recognition');
      if (digest?.content) {
        try {
          const content = JSON.parse(digest.content) as SpeechRecognitionContent;
          if (content.segments) {
            transcriptsByPath.set(sourcePath, content.segments);
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Enrich voice embeddings with individual segments and their transcript text
    const enrichedVoiceEmbeddings = voiceEmbeddings.map((e) => {
      const sourceOffset = e.sourceOffset as VoiceSourceOffset | null;
      const transcriptSegments = transcriptsByPath.get(e.sourcePath) || [];

      // Build segments with matched transcript text
      const segmentsWithText: VoiceSegmentWithText[] = [];
      if (sourceOffset?.segments && sourceOffset.segments.length > 0) {
        for (const embSeg of sourceOffset.segments) {
          // Find all transcript segments that overlap with this embedding segment
          const matchedTexts: string[] = [];
          for (const transSeg of transcriptSegments) {
            const overlap = Math.min(embSeg.end, transSeg.end) - Math.max(embSeg.start, transSeg.start);
            if (overlap > 0.1) {
              matchedTexts.push(transSeg.text);
            }
          }
          segmentsWithText.push({
            start: embSeg.start,
            end: embSeg.end,
            text: matchedTexts.join(' ').trim(),
          });
        }
      }

      return {
        ...e,
        vector: undefined, // Don't send vectors to client
        segmentsWithText,
      };
    });

    return NextResponse.json({
      ...people,
      clusters: {
        voice: voiceClusters,
        face: faceClusters,
      },
      embeddings: {
        voice: enrichedVoiceEmbeddings,
        face: faceEmbeddings.map((e) => ({
          ...e,
          vector: undefined,
        })),
      },
    });
  } catch (error) {
    log.error({ err: error }, 'get people failed');
    return NextResponse.json(
      { error: 'Failed to get people' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/people/[id]
 * Update people name
 *
 * For pending people (no vcfPath), this sets the display name.
 * In a full implementation, this would also create the vCard file.
 *
 * Request body:
 * - displayName: string (required)
 */
export async function PUT(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const people = getPeopleById(id);

    if (!people) {
      return NextResponse.json(
        { error: 'People not found' },
        { status: 404 }
      );
    }

    const body = await request.json();
    const { displayName } = body;

    if (!displayName || typeof displayName !== 'string') {
      return NextResponse.json(
        { error: 'displayName is required' },
        { status: 400 }
      );
    }

    // Update display name
    const updatedPeople = updatePeople(id, {
      displayName: displayName.trim(),
    });

    // TODO: In Phase 2, create/update vCard file here
    // For now, we just update the database

    log.info({ peopleId: id, displayName }, 'updated people');

    return NextResponse.json(updatedPeople);
  } catch (error) {
    log.error({ err: error }, 'update people failed');
    return NextResponse.json(
      { error: 'Failed to update people' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/people/[id]
 * Delete people entry, their clusters, and orphan their embeddings
 *
 * Note: Embeddings are not deleted - they become orphaned (cluster_id = NULL)
 * and can be reassigned to another people entry.
 */
export async function DELETE(
  request: NextRequest,
  context: RouteContext
) {
  try {
    const { id } = await context.params;
    const people = getPeopleById(id);

    if (!people) {
      return NextResponse.json(
        { error: 'People not found' },
        { status: 404 }
      );
    }

    // TODO: In Phase 2, delete vCard file if exists
    // if (people.vcfPath) {
    //   await deleteVCardFile(people.vcfPath);
    // }

    // Delete people (cascades to clusters, embeddings become orphaned)
    deletePeople(id);

    log.info({ peopleId: id, displayName: people.displayName }, 'deleted people');

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'delete people failed');
    return NextResponse.json(
      { error: 'Failed to delete people' },
      { status: 500 }
    );
  }
}
