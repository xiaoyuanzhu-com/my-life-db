/**
 * Digest Layer - Text Summary
 * Business-facing summary function backed by OpenAI.
 * Implement only what we use; keep interface small.
 */

import { callOpenAICompletion } from '~/.server/vendors/openai';

export interface TextSummaryInput {
  text: string;
}

export interface TextSummaryOutput {
  summary: string;
}

export async function summarizeTextDigest(input: TextSummaryInput): Promise<TextSummaryOutput> {
  const prompt = `Summarize the following text in 3-5 bullet points:\n\n${input.text}`;
  // No maxTokens - "3-5 bullet points" naturally bounds the output
  const res = await callOpenAICompletion({ prompt });
  return { summary: res.content };
}

