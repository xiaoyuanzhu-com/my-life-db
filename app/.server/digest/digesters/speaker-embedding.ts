/**
 * Speaker Embedding Digester
 * Extracts speaker embeddings from speech recognition results and auto-clusters them
 *
 * Depends on: speech-recognition digest
 * Produces: speaker-embedding (metadata about extracted embeddings)
 *
 * This digester reads the speech recognition result which contains
 * speaker embeddings (512-dim vectors) and feeds them into the
 * people registry auto-clustering system.
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import type { HaidSpeechRecognitionResponse } from '~/.server/vendors/haid';
import type { VoiceSourceOffset } from '~/types/people-embedding';
import { addEmbeddingWithClustering, listEmbeddingsForSource } from '~/.server/db/people';
import { getLogger } from '~/.server/log/logger';

const log = getLogger({ module: 'SpeakerEmbeddingDigester' });

// Minimum total duration (seconds) for a speaker to be processed
// Filters out short segments that may be noise
const MIN_SPEAKER_DURATION = 2.0;

/**
 * Speaker Embedding Digester
 * Extracts speaker embeddings from ASR results and auto-clusters them into people
 */
export class SpeakerEmbeddingDigester implements Digester {
  readonly name = 'speaker-embedding';
  readonly label = 'Speaker ID';
  readonly description = 'Extract and cluster speaker voice embeddings for identification';

  async canDigest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Check if file is a folder
    if (file.is_folder) {
      return false;
    }

    // Requires completed speech-recognition digest
    const speechDigest = existingDigests.find(
      (d) => d.digester === 'speech-recognition' && d.status === 'completed'
    );
    if (!speechDigest) {
      return false;
    }

    // Check if speech recognition has speaker data
    try {
      const speechResult = JSON.parse(speechDigest.content || '{}') as HaidSpeechRecognitionResponse;
      if (!speechResult.speakers || speechResult.speakers.length === 0) {
        log.debug({ filePath }, 'no speakers in speech recognition result');
        return false;
      }

      // At least one speaker should have sufficient duration
      const hasSufficientSpeakers = speechResult.speakers.some(
        (s) => s.total_duration >= MIN_SPEAKER_DURATION && s.embedding && s.embedding.length > 0
      );
      if (!hasSufficientSpeakers) {
        log.debug({ filePath }, 'no speakers with sufficient duration');
        return false;
      }

      return true;
    } catch (error) {
      log.warn({ filePath, error }, 'failed to parse speech recognition result');
      return false;
    }
  }

  async digest(
    filePath: string,
    file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<DigestInput[] | null> {
    const speechDigest = existingDigests.find(
      (d) => d.digester === 'speech-recognition' && d.status === 'completed'
    );
    if (!speechDigest?.content) {
      throw new Error('Speech recognition digest not found');
    }

    const speechResult = JSON.parse(speechDigest.content) as HaidSpeechRecognitionResponse;
    if (!speechResult.speakers || speechResult.speakers.length === 0) {
      throw new Error('No speakers in speech recognition result');
    }

    log.debug({ filePath, speakerCount: speechResult.speakers.length }, 'processing speaker embeddings');

    // Check if we already have embeddings for this source
    // This prevents duplicate processing on re-digest
    const existingEmbeddings = listEmbeddingsForSource(filePath);
    if (existingEmbeddings.length > 0) {
      log.info({ filePath, existingCount: existingEmbeddings.length }, 'embeddings already exist for source');
      // Return completed status - already processed
      const now = new Date().toISOString();
      return [
        {
          filePath,
          digester: 'speaker-embedding',
          status: 'completed',
          content: JSON.stringify({
            speakersProcessed: 0,
            speakersSkipped: speechResult.speakers.length,
            reason: 'already_processed',
            existingEmbeddings: existingEmbeddings.length,
          }),
          sqlarName: null,
          error: null,
          attempts: 1,
          createdAt: now,
          updatedAt: now,
        },
      ];
    }

    // Process each speaker with sufficient duration
    const processedSpeakers: {
      speakerId: string;
      embeddingId: string;
      clusterId: string;
      peopleId: string;
      isNewPeople: boolean;
      duration: number;
      segmentCount: number;
    }[] = [];

    const skippedSpeakers: { speakerId: string; reason: string }[] = [];

    for (const speaker of speechResult.speakers) {
      // Skip speakers without embeddings or with short duration
      if (!speaker.embedding || speaker.embedding.length === 0) {
        skippedSpeakers.push({ speakerId: speaker.speaker_id, reason: 'no_embedding' });
        continue;
      }

      if (speaker.total_duration < MIN_SPEAKER_DURATION) {
        skippedSpeakers.push({ speakerId: speaker.speaker_id, reason: 'short_duration' });
        continue;
      }

      // Build source offset with all segments for this speaker (including text)
      const speakerSegments = speechResult.segments.filter(
        (seg) => seg.speaker === speaker.speaker_id
      );
      const sourceOffset: VoiceSourceOffset = {
        segments: speakerSegments.map((seg) => ({
          start: seg.start,
          end: seg.end,
          text: seg.text,
        })),
      };

      // Convert embedding array to Float32Array
      const vector = new Float32Array(speaker.embedding);

      try {
        // Add embedding with auto-clustering
        const result = addEmbeddingWithClustering({
          type: 'voice',
          vector,
          sourcePath: filePath,
          sourceOffset,
          quality: speaker.total_duration,
        });

        processedSpeakers.push({
          speakerId: speaker.speaker_id,
          embeddingId: result.embedding.id,
          clusterId: result.cluster.id,
          peopleId: result.people.id,
          isNewPeople: result.isNewPeople,
          duration: speaker.total_duration,
          segmentCount: speaker.segment_count,
        });

        log.info(
          {
            filePath,
            speakerId: speaker.speaker_id,
            embeddingId: result.embedding.id,
            peopleId: result.people.id,
            isNewPeople: result.isNewPeople,
          },
          'processed speaker embedding'
        );
      } catch (error) {
        log.error({ filePath, speakerId: speaker.speaker_id, error }, 'failed to process speaker embedding');
        skippedSpeakers.push({ speakerId: speaker.speaker_id, reason: 'clustering_error' });
      }
    }

    const now = new Date().toISOString();

    // Store summary of processing
    return [
      {
        filePath,
        digester: 'speaker-embedding',
        status: 'completed',
        content: JSON.stringify({
          speakersProcessed: processedSpeakers.length,
          speakersSkipped: skippedSpeakers.length,
          processed: processedSpeakers,
          skipped: skippedSpeakers,
        }),
        sqlarName: null,
        error: null,
        attempts: 1,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  /**
   * Re-process if speech recognition was updated
   */
  shouldReprocessCompleted(
    _filePath: string,
    _file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): boolean {
    const speechDigest = existingDigests.find((d) => d.digester === 'speech-recognition');
    const embeddingDigest = existingDigests.find((d) => d.digester === 'speaker-embedding');

    if (!speechDigest || !embeddingDigest) {
      return false;
    }

    // Re-process if speech recognition was updated after embedding extraction
    const speechUpdated = new Date(speechDigest.updatedAt);
    const embeddingUpdated = new Date(embeddingDigest.updatedAt);

    return speechUpdated > embeddingUpdated;
  }
}
