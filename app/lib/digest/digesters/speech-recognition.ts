/**
 * Speech Recognition Digester
 * Transcribes audio files to text using HAID whisperx with speaker diarization
 * (Can be extended to support video files in the future)
 */

import type { Digester } from '../types';
import type { Digest, DigestInput, FileRecordRow } from '~/types';
import type BetterSqlite3 from 'better-sqlite3';
import { speechRecognitionWithHaid } from '~/lib/vendors/haid';
import { DATA_ROOT } from '~/lib/fs/storage';
import { getLogger } from '~/lib/log/logger';
import path from 'path';

const log = getLogger({ module: 'SpeechRecognitionDigester' });

// Supported audio MIME types
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
 * Speech Recognition Digester
 * Transcribes audio files to text using HAID whisperx with speaker diarization
 */
export class SpeechRecognitionDigester implements Digester {
  readonly name = 'speech-recognition';
  readonly label = 'Speech Recognition';
  readonly description = 'Transcribe audio files to text with speaker diarization';

  async canDigest(
    filePath: string,
    file: FileRecordRow,
    _existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<boolean> {
    // Check if file is a folder
    if (file.is_folder) {
      return false;
    }

    // Check MIME type first
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
    file: FileRecordRow,
    _existingDigests: Digest[],
    _db: BetterSqlite3.Database
  ): Promise<DigestInput[] | null> {
    log.debug({ filePath, name: file.name }, 'transcribing audio file');

    // Get absolute path to audio file
    const absolutePath = path.join(DATA_ROOT, filePath);

    // Transcribe audio using HAID whisperx with diarization
    // Let errors propagate - coordinator handles retry logic
    const result = await speechRecognitionWithHaid({
      audioPath: absolutePath,
    });

    // Store the full JSON response
    const jsonContent = JSON.stringify(result, null, 2);

    const now = new Date().toISOString();

    return [
      {
        filePath,
        digester: 'speech-recognition',
        status: 'completed',
        content: jsonContent,
        sqlarName: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
