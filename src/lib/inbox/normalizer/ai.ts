import 'server-only';
// AI-first Inbox Folder Normalizer
// Builds a compact prompt from a folder inventory and asks the configured AI
// to best-effort map legacy shapes to the current InboxItem fields.

import type { FileType, MessageType } from '@/types';
import { callOpenAICompletion, isOpenAIConfigured } from '@/lib/vendors/openai';
import { z } from 'zod';

export interface FolderFileSummary {
  filename: string;
  size: number;
  mimeType: string;
  type: FileType;
}

export interface NormalizeWithAIInput {
  folderName: string;
  files: FolderFileSummary[];
  samples?: Record<string, string>; // small text samples by filename
  metadataJson?: unknown; // parsed metadata.json if present
}

export interface NormalizedProposal {
  normalized?: {
    id?: string | null;
    type?: MessageType | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    files?: Array<{
      filename: string;
      type?: FileType;
      enrichment?: Record<string, unknown>;
    }>;
  };
  actions?: Array<{ kind: string; [key: string]: unknown }>;
  reasoning?: string;
  confidence?: number; // 0-1
  normalizerVersion: number;
}

// Zod schemas to validate AI JSON
const FileTypeSchema = z.enum(['text', 'image', 'audio', 'video', 'pdf', 'other']);
const MessageTypeSchema = z.enum(['text', 'url', 'image', 'audio', 'video', 'pdf', 'mixed']);

const NormalizedFilesSchema = z.object({
  filename: z.string(),
  type: FileTypeSchema.optional(),
  enrichment: z.record(z.string(), z.unknown()).optional(),
});

const NormalizedSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  type: MessageTypeSchema.nullable().optional(),
  createdAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime().nullable().optional(),
  files: z.array(NormalizedFilesSchema).optional(),
});

const NormalizedProposalSchema = z.object({
  normalized: NormalizedSchema.optional(),
  actions: z.array(z.object({ kind: z.string() }).catchall(z.unknown())).optional(),
  reasoning: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  normalizerVersion: z.number().int().min(1).default(1),
});

function buildPrompt(input: NormalizeWithAIInput): string {
  const schemaBrief = `Current InboxItem fields (projection only):\n` +
    `- id: UUID string\n` +
    `- folderName: current folder name (unchanged here)\n` +
    `- type: one of ['text','url','image','audio','video','pdf','mixed']\n` +
    `- files: list of files with filename, size, mimeType, type\n` +
    `- createdAt/updatedAt: ISO strings (optional to infer)\n` +
    `Note: Do not invent content; infer conservatively. If unsure, return null.\n`;

  const filesList = input.files
    .map(f => `- ${f.filename} (${f.mimeType}, ${f.size} bytes, ${f.type})`)
    .join('\n');

  const md = input.metadataJson
    ? `metadata.json (parsed):\n${JSON.stringify(input.metadataJson).slice(0, 2000)}\n`
    : 'metadata.json: (absent)\n';

  const samples: string = input.samples
    ? Object.entries(input.samples)
        .map(([name, text]) => `>>> ${name}\n${truncate(text, 400)}\n`)
        .join('\n')
    : '';

  const outputSpec = `Output strictly JSON with keys: {\n` +
    `  "normalized": {\n` +
    `    "id": string|null,\n` +
    `    "type": "text"|"url"|"image"|"audio"|"video"|"pdf"|"mixed"|null,\n` +
    `    "createdAt": string|null,\n` +
    `    "updatedAt": string|null,\n` +
    `    "files": Array<{"filename": string, "type"?: string, "enrichment"?: object}>\n` +
    `  },\n` +
    `  "actions": Array<{"kind": string, ... }>,\n` +
    `  "reasoning": string,\n` +
    `  "confidence": number,\n` +
    `  "normalizerVersion": 1\n` +
    `}\n` +
    `Return only JSON, no prose. If fields cannot be inferred, use null.\n`;

  return [
    'You are an expert data normalizer. Best-effort map legacy inbox folders to the current schema.\n',
    schemaBrief,
    `Folder: ${input.folderName}\nFiles:\n${filesList}\n`,
    md,
    samples ? `Text samples (truncated):\n${samples}` : '',
    outputSpec,
  ].join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

export async function normalizeWithAI(input: NormalizeWithAIInput): Promise<NormalizedProposal | null> {
  if (!(await isOpenAIConfigured())) return null;

  const prompt = buildPrompt(input);
  try {
    const completion = await callOpenAICompletion({
      systemPrompt: 'You are an expert data normalizer that maps legacy inbox folders into the current schema.',
      prompt,
      temperature: 0,
      // No maxTokens - let model stop naturally after completing the JSON
    });
    const raw = completion.content;
    // Expect strict JSON
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    const jsonStr = firstBrace >= 0 && lastBrace >= 0 ? raw.slice(firstBrace, lastBrace + 1) : raw;
    const json = JSON.parse(jsonStr);
    const result = NormalizedProposalSchema.safeParse(json);
    if (!result.success) {
      return null;
    }
    const value = result.data as NormalizedProposal;
    if (typeof value.normalizerVersion !== 'number') value.normalizerVersion = 1;
    return value;
  } catch {
    return null;
  }
}
