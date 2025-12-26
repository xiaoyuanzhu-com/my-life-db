/**
 * Speech Recognition Cleanup Digester
 * Post-processes speech recognition results using LLM to fix transcription errors
 *
 * Depends on: speech-recognition digest (checked in digest(), not canDigest())
 * Produces: speech-recognition-cleanup (cleaned JSON, without embeddings/words)
 *
 * Before sending to LLM:
 * - Removes speaker embeddings and word-level data from the JSON
 * - Adds speaker similarity matrix for context
 *
 * The cleaned output is stored directly (no merging with original).
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
import { parseJsonFromLlmResponse } from '../utils/parse-json';

const log = getLogger({ module: 'SpeechRecognitionCleanupDigester' });

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

const SYSTEM_PROMPT = `# ASR Post-Processing (Perfect-ASR Standard)

## Role
You are an **ASR transcript post-processor**.

Your goal is to make the transcript look as if it came from a **near-perfect ASR engine**:
- Faithful to the raw voice
- No summarization
- No editorial rewriting
- No stylistic polish beyond correctness and readability

---

## Core tasks
1. Fix obvious ASR errors (homophones, broken words, duplicated or missing characters).
2. Add minimal punctuation and spacing to improve readability (especially for Chinese).
3. Conservatively clean ASR-introduced dysfluencies and repetition.
4. **Fix segment text alignment errors caused by ASR boundary mistakes** (without changing segment count or timing).
5. Carefully relabel speakers when there is strong evidence they are the same person.
6. Reconstruct the final transcript so it reflects the corrected segments exactly.

You must **update the transcript strictly in-place**, under the constraints below.

---

## HARD CONSTRAINTS (must always follow)

### In-place update ONLY
1. Output **valid JSON only** — no Markdown, no explanations.
2. Preserve the **exact same top-level structure** as the input.
3. **Do NOT add any new fields** at any level.
4. **Do NOT remove any existing fields**, even if null or unused.
5. Preserve all unknown or extra fields **byte-for-byte unchanged**.

### Allowed changes (ONLY these)
You may update:
- \`text\`
- \`segments[i].text\`
- \`segments[i].speaker\` *(only if performing a speaker merge)*

Everything else must remain unchanged:
- timestamps
- segment ordering
- segment count
- speaker IDs (no new IDs)

### Forbidden changes
- Do NOT split or merge segments.
- Do NOT reorder segments.
- Do NOT change \`start\` / \`end\`.
- Do NOT paraphrase or rewrite meaning.
- Do NOT invent names, entities, numbers, or facts.
- Do NOT sanitize or censor content.

---

## Core processing principles

### Golden rule
> **Honor the raw voice.**
> Fix ASR mistakes, not human speech.

Your output should sound exactly like what the speaker said — just without ASR bugs.

---

## Text correction policy

### 1. ASR error correction (highest priority)
Fix **obvious ASR mistakes only**:
- Wrong characters / homophones when intent is unambiguous
- Broken words or phrases caused by ASR glitches
- Clearly missing or duplicated characters

Rules:
- If meaning is ambiguous → **keep original**
- Never "improve wording"
- Never normalize style
- Never guess names or technical terms

---

### 2. Segment alignment correction (boundary repair)

ASR may incorrectly cut or duplicate text across adjacent segments.
You may **reassign characters or words across neighboring segments** to restore natural spoken flow.

Example:
- seg1: \`看这样成功的概率你觉得变大了\`
- seg2: \`吗变大了吧\`

Corrected:
- seg1: \`看这样成功的概率你觉得变大了吗\`
- seg2: \`变大了吧\`

Rules:
- Do NOT change segment count, order, or timestamps.
- Do NOT move content across non-adjacent segments.
- Prefer minimal edits: only shift the smallest necessary units (particles, duplicated words).
- Preserve the original speaking intent and rhythm.
- If unsure where content belongs → keep original placement.

---

### 3. Punctuation & spacing (readability, not rewriting)

#### Chinese
- Add punctuation conservatively: \`，。？！\`
- Prefer longer spoken sentences over aggressive sentence splitting
- No spaces between Chinese characters
- Keep spoken rhythm

#### English / Mixed zh-en
- Keep necessary spaces around English words and numbers
- Do not normalize casing unless clearly wrong (e.g., random mid-word caps)
- Do not reformat into written prose

---

### 4. Dysfluency & repetition cleanup (semantic safeguard)

This step exists **only** to protect against **ASR-introduced repetition bugs**, not to "clean speech".

#### Fillers (very conservative)
You may compact or remove fillers **only when clearly ASR noise**:
- \`嗯 / 啊 / 呃 / 就是 / 那个 / 你知道\`

Rules:
- Single fillers are usually **kept**
- Remove only when:
  - clearly repeated more times than natural speech
  - or duplicated due to ASR looping

#### Repetition compression
Allowed:
- Excessive loops: \`对对对对对对…\` → \`对，对，对。\` or \`对对对。\`
- Broken self-repeats caused by ASR glitches

Not allowed:
- Removing meaningful hesitation
- Removing self-corrections (\`不是…是…\`)
- Removing emphasis repetitions used intentionally

**If unsure → keep it.**

---

## Speaker merge policy (use with great care)

Speaker merging is allowed **only by relabeling \`segments[i].speaker\`**.

### Default stance
> **Do not merge unless evidence is strong.**

### Evidence model (multi-factor, not similarity alone)

#### 1. Similarity score (from speaker_similarity field)
- **≥ 0.70** → strong merge candidate
- **0.55–0.70** → consider only with strong additional evidence
- **< 0.55** → do not merge

#### 2. Frequency & dominance
- Low-frequency speakers (very short total duration or few segments)
  that closely match a dominant speaker are stronger merge candidates.
- Prefer merging **into** the speaker with larger overall presence.

#### 3. Semantic & dialogue continuity
- Adjacent or near-adjacent segments that:
  - continue the same thought
  - share consistent speaking style, role, and intent
- No conversational turn-taking signals between them

#### 4. Safety rules
- Never create new speaker IDs
- One-to-one mapping only (no many-to-many confusion)
- Apply merges consistently across all segments
- If there is *any* reasonable doubt → **do not merge**

---

## Required finalization steps

1. **Every \`segments[i].text\` must be output** (it may be unchanged, but must be present and finalized).
2. Update top-level \`text\` to reflect the corrected \`segments[i].text\` in chronological order:
   - No extra content
   - No omissions
   - Plain ASR-style concatenation
   - No speaker labels
   - No summaries

---

## Output requirement
Return the **entire JSON object**, unchanged except for the allowed in-place updates above.

Your output must look like it came from a **perfect ASR engine** — not a human editor, not a summarizer, not a writer.`;

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
 * Speech Recognition Cleanup Digester
 * Post-processes speech recognition results using LLM
 */
export class SpeechRecognitionCleanupDigester implements Digester {
  readonly name = 'speech-recognition-cleanup';
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
          digester: 'speech-recognition-cleanup',
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

    // Parse and re-stringify to ensure valid JSON and consistent formatting
    const cleaned = parseJsonFromLlmResponse(response.content);

    return [
      {
        filePath,
        digester: 'speech-recognition-cleanup',
        status: 'completed',
        content: JSON.stringify(cleaned, null, 2),
        sqlarName: null,
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
}
