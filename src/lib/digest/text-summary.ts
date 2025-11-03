import 'server-only';
/**
 * Digest Layer - Text Summary
 * Business-facing summary function backed by OpenAI.
 * Implement only what we use; keep interface small.
 */

import { callOpenAICompletion } from '@/lib/vendors/openai';

export interface TextSummaryInput {
  text: string;
  maxTokens?: number;
}

export interface TextSummaryOutput {
  summary: string;
}

export async function summarizeTextDigest(input: TextSummaryInput): Promise<TextSummaryOutput> {
  const prompt = `Summarize the following text in 3-5 bullet points:\n\n${input.text}`;
  const res = await callOpenAICompletion({ prompt, maxTokens: input.maxTokens ?? 256 });
  return { summary: res.content };
}

