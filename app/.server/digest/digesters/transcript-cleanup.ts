/**
 * Transcript Cleanup Digester
 * Post-processes speech recognition results using LLM to fix transcription errors
 *
 * Depends on: speech-recognition digest (checked in digest(), not canDigest())
 * Produces: transcript-cleanup (cleaned JSON in same format as speech-recognition)
 *
 * Before sending to LLM:
 * - Removes speaker embeddings from the JSON
 * - Adds speaker similarity matrix for context
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  HaidSpeechRecognitionResponse,
  HaidSpeechRecognitionSpeaker,
} from '~/.server/vendors/haid';
import { callOpenAICompletion } from '~/.server/vendors/openai';
import { getLogger } from '~/.server/log/logger';
import { parseJsonFromLlmResponse } from '~/.server/utils/parse-json';

const log = getLogger({ module: 'TranscriptCleanupDigester' });

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
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Build speaker similarity matrix from embeddings
 */
function buildSpeakerSimilarityMatrix(
  speakers: HaidSpeechRecognitionSpeaker[]
): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {};

  for (const speaker of speakers) {
    matrix[speaker.speaker_id] = {};
    for (const other of speakers) {
      if (speaker.embedding && other.embedding) {
        const similarity = cosineSimilarity(speaker.embedding, other.embedding);
        matrix[speaker.speaker_id][other.speaker_id] = Math.round(similarity * 1000) / 1000;
      }
    }
  }

  return matrix;
}

/**
 * Segment without words for LLM processing
 */
interface PreparedSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
}

/**
 * Prepare transcript for LLM by removing embeddings, words, and adding similarity matrix
 */
interface PreparedTranscript {
  request_id: string;
  processing_time_ms: number;
  text: string;
  language: string;
  model: string;
  segments: PreparedSegment[];
  speakers?: Array<{
    speaker_id: string;
    total_duration: number;
    segment_count: number;
  }>;
  speaker_similarity?: Record<string, Record<string, number>>;
}

function prepareTranscriptForLlm(
  speechResult: HaidSpeechRecognitionResponse
): PreparedTranscript {
  const prepared: PreparedTranscript = {
    request_id: speechResult.request_id,
    processing_time_ms: speechResult.processing_time_ms,
    text: speechResult.text,
    language: speechResult.language,
    model: speechResult.model,
    // Strip words from segments to reduce token usage
    segments: speechResult.segments.map((seg) => ({
      start: seg.start,
      end: seg.end,
      text: seg.text,
      speaker: seg.speaker,
    })),
  };

  if (speechResult.speakers && speechResult.speakers.length > 0) {
    // Add speakers without embeddings
    prepared.speakers = speechResult.speakers.map((s) => ({
      speaker_id: s.speaker_id,
      total_duration: s.total_duration,
      segment_count: s.segment_count,
    }));

    // Add similarity matrix
    prepared.speaker_similarity = buildSpeakerSimilarityMatrix(speechResult.speakers);
  }

  return prepared;
}

/**
 * Merge cleaned segments back with original embeddings and words
 */
function mergeCleanedWithOriginal(
  cleaned: PreparedTranscript,
  original: HaidSpeechRecognitionResponse
): HaidSpeechRecognitionResponse {
  // Create a map of original segments by index for word restoration
  const mergedSegments = cleaned.segments.map((cleanedSeg, index) => {
    const originalSeg = original.segments[index];
    return {
      ...cleanedSeg,
      // Restore original words (LLM only edits segment-level text)
      words: originalSeg?.words ?? [],
    };
  });

  return {
    request_id: cleaned.request_id,
    processing_time_ms: cleaned.processing_time_ms,
    text: cleaned.text,
    language: cleaned.language,
    model: cleaned.model,
    segments: mergedSegments,
    speakers: original.speakers, // Restore original speakers with embeddings
  };
}

const SYSTEM_PROMPT = `You are a transcript editor. Your task is to clean up and polish speech recognition results.

Fix common transcription errors:
- Correct misheard words based on context
- Fix punctuation and capitalization
- Merge fragmented sentences
- Remove filler words (um, uh, like) if they disrupt flow
- Fix speaker attribution errors when obvious from context

Return the JSON in the exact same format as input. Only modify the text fields.`;

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    request_id: { type: 'string' },
    processing_time_ms: { type: 'number' },
    text: { type: 'string' },
    language: { type: 'string' },
    model: { type: 'string' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          text: { type: 'string' },
          speaker: { type: 'string' },
        },
        required: ['start', 'end', 'text', 'speaker'],
        additionalProperties: false,
      },
    },
    speakers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speaker_id: { type: 'string' },
          total_duration: { type: 'number' },
          segment_count: { type: 'number' },
        },
        required: ['speaker_id', 'total_duration', 'segment_count'],
        additionalProperties: false,
      },
    },
    speaker_similarity: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: { type: 'number' },
      },
    },
  },
  required: ['request_id', 'processing_time_ms', 'text', 'language', 'model', 'segments'],
  additionalProperties: false,
};

/**
 * Transcript Cleanup Digester
 * Post-processes speech recognition results using LLM
 */
export class TranscriptCleanupDigester implements Digester {
  readonly name = 'transcript-cleanup';
  readonly label = 'Speech Recognition Cleanup';
  readonly description = 'Polish and fix speech recognition results using LLM';

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

    // No segments to clean - complete with null
    if (!speechResult.segments || speechResult.segments.length === 0) {
      log.debug({ filePath }, 'no segments to clean');
      return [
        {
          filePath,
          digester: 'transcript-cleanup',
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

    log.debug({ filePath, segmentCount: speechResult.segments.length }, 'cleaning transcript');

    // Prepare transcript for LLM (remove embeddings, add similarity)
    const prepared = prepareTranscriptForLlm(speechResult);

    // Call LLM to clean transcript
    const response = await callOpenAICompletion({
      systemPrompt: SYSTEM_PROMPT,
      prompt: JSON.stringify(prepared, null, 2),
      jsonSchema: JSON_SCHEMA,
      temperature: 0.3,
      frequencyPenalty: 0.5, // Reduce repetition of tokens
      presencePenalty: 0.3,  // Discourage repeating any token that appeared
    });

    // Parse cleaned result
    const cleanedPrepared = parseJsonFromLlmResponse(response.content) as PreparedTranscript;

    // Merge cleaned segments back with original embeddings
    const cleanedResult = mergeCleanedWithOriginal(cleanedPrepared, speechResult);

    return [
      {
        filePath,
        digester: 'transcript-cleanup',
        status: 'completed',
        content: JSON.stringify(cleanedResult, null, 2),
        sqlarName: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
