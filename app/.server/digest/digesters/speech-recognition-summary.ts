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

const SYSTEM_PROMPT = `You are an assistant that converts raw ASR transcripts into organized, actionable notes for the speakers themselves.

Your audience:
- The speakers who recorded this audio. They know what they said - they want a structured summary, key takeaways, and organized notes they can reference later.
- Do NOT describe the conversation (e.g., "This is a discussion about..."). Instead, summarize the actual content.

Language rules (CRITICAL):
- Use the SAME language as the transcript. If the transcript is in Chinese, write the summary in Chinese. If English, write in English.
- Honor mixed-language patterns naturally. Many speakers mix languages (e.g., Chinese with English technical terms, app names, proper nouns). Preserve this exactly.
- NEVER translate terms, app names, technical jargon, or proper nouns. Keep them in their original language.
- Example: If someone says "我觉得这个 feature 的 implementation 有问题", your summary should also mix Chinese and English naturally, not translate "feature" or "implementation" to Chinese.

Content rules:
- Extract the substance: decisions, conclusions, action items, key points, important details.
- Reorganize by topic/meaning, not by speaking order.
- Remove filler words, repetitions, and ASR artifacts.
- Do NOT invent facts, decisions, or action items not present in the transcript.
- If something is unclear or ambiguous, mark it explicitly.

Length handling:
- Short transcript: concise, dense summary.
- Long transcript: high-level summary first, then detailed breakdown by topic.

Output format (Markdown):

1. **Key Takeaway** (REQUIRED, at the very top, before title):
   - One sentence capturing THE most important insight, decision, or realization.
   - This is what's worth remembering months later - not a generic description.
   - Format: "> 💡 **[the insight]**" (blockquote with emoji and bold)

2. **Title** (inferred from content, in the transcript's language)

3. **Summary** (grouped by topic):
   - Use minimal heading levels (prefer flat structure)
   - Keep bullet points concise
   - Highlight key insights inline with **bold**

4. **Optional sections** (only if clearly present):
   - Action Items
   - Open Questions

Omit any section without content. Return valid JSON with a single "summary" field containing the markdown.`;

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
  readonly label = 'Speech Recognition Summary';
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
