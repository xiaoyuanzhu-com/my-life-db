import 'server-only';

import { callOpenAICompletion } from '@/lib/vendors/openai';

export interface TaggingInput {
  text: string;
  maxTags?: number;
}

export interface TaggingOutput {
  tags: string[];
}

export async function generateTagsDigest(input: TaggingInput): Promise<TaggingOutput> {
  const maxTags = input.maxTags ?? 5;

  const schema = {
    type: 'object',
    properties: {
      tags: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: maxTags,
      },
    },
    required: ['tags'],
    additionalProperties: false,
  };

  const systemPrompt = [
    'You are an expert knowledge organizer.',
    'Extract 2-5 short, descriptive tags that help classify the content.',
    'Prefer single or double-word tags; no hashtags or numbering.',
  ].join(' ');

  const prompt = [
    'Analyze the following content and produce tags as a JSON array.',
    'Respond using the provided schema.',
    '',
    input.text,
  ].join('\n');

  const res = await callOpenAICompletion({
    systemPrompt,
    prompt,
    maxTokens: 200,
    jsonSchema: schema,
    temperature: 0.3,
  });

  let tags: string[] = [];
  try {
    const payload = JSON.parse(res.content) as { tags?: unknown };
    if (Array.isArray(payload.tags)) {
      tags = payload.tags
        .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
        .filter((tag) => tag.length > 0);
    }
  } catch {
    // fall back to simple parsing if JSON schema fails unexpectedly
    tags = res.content
      .split(/[\n,]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }

  // Deduplicate and limit to maxTags
  const unique = Array.from(new Set(tags.map((tag) => tag.toLowerCase()))).slice(0, maxTags);

  return {
    tags: unique,
  };
}
