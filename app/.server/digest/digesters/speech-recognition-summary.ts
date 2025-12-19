/**
 * Speech Recognition Summary Digester
 * Generates a markdown summary of speech recognition transcripts using LLM
 *
 * Depends on: speech-recognition digest (checked in digest(), not canDigest())
 * Produces: speech-recognition-summary (JSON with markdown summary)
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import type { HaidSpeechRecognitionResponse } from '~/.server/vendors/haid';
import { callOpenAICompletion } from '~/.server/vendors/openai';
import { getLogger } from '~/.server/log/logger';
import { parseJsonFromLlmResponse } from '~/.server/utils/parse-json';

const log = getLogger({ module: 'SpeechRecognitionSummaryDigester' });

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

const SYSTEM_PROMPT = `You are an expert summarizer. Given a speech transcript, produce a concise summary in markdown format.

Your summary should:
- Capture the main topics and key points discussed
- Be well-structured with headings if appropriate
- Preserve important names, numbers, and specific details
- Be concise but comprehensive

Output format: Return valid JSON with a single "summary" field containing the markdown summary.
Example: {"summary": "# Meeting Summary\\n\\n## Key Points\\n- Point 1\\n- Point 2"}`;

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
  },
  required: ['summary'],
  additionalProperties: false,
};

/**
 * Speech Recognition Summary Digester
 * Generates markdown summary from speech transcripts
 */
export class SpeechRecognitionSummaryDigester implements Digester {
  readonly name = 'speech-recognition-summary';
  readonly label = 'Speech Summary';
  readonly description = 'Generate summary from speech recognition transcript';

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

    // No text to summarize - complete with null
    if (!speechResult.text || speechResult.text.trim().length === 0) {
      log.debug({ filePath }, 'no text to summarize');
      return [
        {
          filePath,
          digester: 'speech-recognition-summary',
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

    log.debug({ filePath, textLength: speechResult.text.length }, 'summarizing transcript');

    // Call LLM to generate summary
    const response = await callOpenAICompletion({
      systemPrompt: SYSTEM_PROMPT,
      prompt: speechResult.text,
      jsonSchema: JSON_SCHEMA,
      temperature: 0.3,
    });

    // Parse and re-stringify to ensure valid JSON
    const result = parseJsonFromLlmResponse(response.content);

    return [
      {
        filePath,
        digester: 'speech-recognition-summary',
        status: 'completed',
        content: JSON.stringify(result, null, 2),
        sqlarName: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
