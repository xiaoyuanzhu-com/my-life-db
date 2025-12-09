import 'server-only';

import { callOpenAICompletion } from '~/lib/vendors/openai';
import { getLogger } from '~/lib/log/logger';

const log = getLogger({ module: 'TagsDigester' });

/**
 * Attempts to extract and parse JSON from a string that may contain additional text.
 * Handles cases where LLM returns JSON wrapped in markdown, with extra text, etc.
 */
function parseJsonFromResponse(content: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(content);
  } catch {
    // If direct parse fails, try to extract JSON from the content

    // Try to find JSON in markdown code blocks
    const markdownJsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (markdownJsonMatch) {
      try {
        return JSON.parse(markdownJsonMatch[1]);
      } catch {
        // Continue to next strategy
      }
    }

    // Try to find JSON object by looking for { ... }
    const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) {
      try {
        return JSON.parse(jsonObjectMatch[0]);
      } catch {
        // Continue to next strategy
      }
    }

    // Try to find JSON array by looking for [ ... ]
    const jsonArrayMatch = content.match(/\[[\s\S]*\]/);
    if (jsonArrayMatch) {
      try {
        return JSON.parse(jsonArrayMatch[0]);
      } catch {
        // All strategies failed
      }
    }

    // If all strategies fail, throw the original error
    throw new Error('Unable to parse JSON from response');
  }
}

export interface TaggingInput {
  text: string;
  maxTags?: number;
}

export interface TaggingOutput {
  tags: string[];
}

export async function generateTagsDigest(input: TaggingInput): Promise<TaggingOutput> {
  const maxTags = input.maxTags ?? 10;

  const schema = {
    type: 'object',
    properties: {
      tags: {
        type: 'array',
        items: { type: 'string' },
        minItems: 5,
        maxItems: maxTags,
      },
    },
    required: ['tags'],
    additionalProperties: false,
  };

  const systemPrompt = [
    'You are an expert knowledge organizer.',
    'Extract 5-10 short, descriptive tags that help classify the content.',
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
    // No maxTokens limit - let the model stop naturally after completing the JSON
    // This is safe because jsonSchema ensures bounded, structured output
    jsonSchema: schema,
    temperature: 0.1, // Low temperature for more consistent tags across runs
  });

  let tags: string[] = [];
  try {
    const payload = parseJsonFromResponse(res.content) as { tags?: unknown } | unknown[];

    // Handle both formats:
    // 1. Correct format: {"tags": ["tag1", "tag2"]}
    // 2. Array format: ["tag1", "tag2"] (some models ignore schema)
    let tagsArray: unknown[] | undefined;

    if (Array.isArray(payload)) {
      // Direct array format
      tagsArray = payload;
    } else if (typeof payload === 'object' && payload !== null && 'tags' in payload) {
      // Correct object format with tags property
      tagsArray = Array.isArray((payload as { tags?: unknown }).tags)
        ? (payload as { tags: unknown[] }).tags
        : undefined;
    }

    if (tagsArray) {
      tags = tagsArray
        .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
        .filter((tag) => tag.length > 0);
    }
  } catch (error) {
    // fall back to simple parsing if JSON schema fails unexpectedly
    const err = error instanceof Error ? error : new Error(String(error));
    log.error(
      {
        error: err.message,
        rawContentPreview: res.content.substring(0, 500),
        rawContentLength: res.content.length,
      },
      'failed to parse JSON response from LLM'
    );
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
