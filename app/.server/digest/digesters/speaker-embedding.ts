/**
 * Speaker Embedding Digester
 * Extracts speaker embeddings from speech recognition results and auto-clusters them
 *
 * Depends on: speech-recognition digest (checked in digest(), not canDigest())
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

// Supported audio MIME types (same as speech-recognition)
const SUPPORTED_MIME_TYPES = new Set([
  'audio/mpeg',      // .mp3
  'audio/wav',       // .wav
  'audio/x-wav',     // .wav alternative
  'audio/ogg',       // .ogg
  'audio/mp4',       // .m4a
  'audio/x-m4a',     // .m4a alternative
  'audio/aac',       // .aac
  'audio/flac',      // .flac
  'audio/x-flac',    // .flac alternative
  'audio/webm',      // .webm audio
  'audio/opus',      // .opus
  'audio/aiff',      // .aiff
  'audio/x-aiff',    // .aiff alternative
]);

// File extensions as fallback check
const SUPPORTED_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.aac',
  '.flac',
  '.webm',
  '.opus',
  '.aiff',
  '.wma',
]);

/**
 * Speaker Embedding Digester
 * Extracts speaker embeddings from ASR results and auto-clusters them into people
 */
export class SpeakerEmbeddingDigester implements Digester {
  readonly name = 'speaker-embedding';
  readonly label = 'Speaker ID';
  readonly description = 'Extract and cluster speaker voice embeddings for identification';

  async canDigest(
    _filePath: string,
    file: FileRecordRow,
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Check if file is a folder
    if (file.is_folder) {
      return false;
    }

    // Check MIME type - same as speech-recognition
    if (file.mime_type && SUPPORTED_MIME_TYPES.has(file.mime_type)) {
      return true;
    }

    // Fallback: check file extension
    const fileName = file.name.toLowerCase();
    for (const ext of SUPPORTED_EXTENSIONS) {
      if (fileName.endsWith(ext)) {
        return true;
      }
    }

    return false;
  }

  async digest(
    filePath: string,
    _file: FileRecordRow,
    existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<DigestInput[]> {
    const now = new Date().toISOString();

    // Check dependency: speech-recognition must be completed
    const speechDigest = existingDigests.find(
      (d) => d.digester === 'speech-recognition' && d.status === 'completed'
    );
    if (!speechDigest?.content) {
      // Dependency not ready - throw error (will retry)
      throw new Error('Speech recognition not completed yet');
    }

    const speechResult = JSON.parse(speechDigest.content) as HaidSpeechRecognitionResponse;

    // No speakers in result - complete with null (not an error)
    if (!speechResult.speakers || speechResult.speakers.length === 0) {
      log.debug({ filePath }, 'no speakers in speech recognition result');
      return [
        {
          filePath,
          digester: 'speaker-embedding',
          status: 'completed',
          content: null,
          sqlarName: null,
          error: null,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        },
      ];
    }

    // Check if any speakers have sufficient duration and embeddings
    const hasSufficientSpeakers = speechResult.speakers.some(
      (s) => s.total_duration >= MIN_SPEAKER_DURATION && s.embedding && s.embedding.length > 0
    );
    if (!hasSufficientSpeakers) {
      log.debug({ filePath }, 'no speakers with sufficient duration or embeddings');
      return [
        {
          filePath,
          digester: 'speaker-embedding',
          status: 'completed',
          content: JSON.stringify({ reason: 'no_sufficient_speakers' }),
          sqlarName: null,
          error: null,
          attempts: 0,
          createdAt: now,
          updatedAt: now,
        },
      ];
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
}
