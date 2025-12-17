
import { callOpenAICompletion } from '~/.server/vendors/openai';
import { getLogger } from '~/.server/log/logger';
import { loadSettings } from '~/.server/config/storage';
import { getNativeLanguageDisplayName } from '~/lib/i18n/languages';

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
  languages?: string[]; // Optional override; if not provided, uses user settings
}

export interface TaggingOutput {
  tags: string[];
}

// Default to English if no language preferences set
const DEFAULT_LANGUAGES = ['en'];

export async function generateTagsDigest(input: TaggingInput): Promise<TaggingOutput> {
  const maxTags = input.maxTags ?? 20;

  // Get user language preferences
  let languages = input.languages;
  if (!languages || languages.length === 0) {
    try {
      const settings = await loadSettings();
      languages = settings.preferences.languages;
    } catch (error) {
      log.warn({ error }, 'failed to load user language settings, using default');
    }
  }

  // Fall back to English if still no languages
  if (!languages || languages.length === 0) {
    languages = DEFAULT_LANGUAGES;
  }

  // Use native language names (e.g., "English, 简体中文, 日本語")
  const languageNames = languages.map(getNativeLanguageDisplayName);

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

  // Build the language instruction
  let languageInstruction: string;
  if (languages.length === 1) {
    languageInstruction = `Generate all tags in ${languageNames[0]}.`;
  } else {
    languageInstruction = `Generate tags in each of these languages: ${languageNames.join(', ')}. Include 5-10 tags per language. Tags across languages should have similar meanings where possible, but don't force exact translations - it's fine to have semantic variations if there's no good equivalent.`;
  }

  const systemPrompt = [
    'You are an expert knowledge organizer.',
    'Extract short, descriptive tags that help classify the content.',
    'Tag format rules:',
    '- Use lowercase with spaces for multi-word tags (e.g., "open source", "machine learning")',
    '- Honor established naming conventions for proper nouns and technical terms (e.g., "iOS", "JavaScript", "GitHub", "macOS")',
    '- Prefer single words when possible, use 2-3 word phrases when needed for clarity',
    '- No hashtags, numbering, or punctuation',
    languageInstruction,
  ].join(' ');

  const prompt = [
    'Analyze the following content and produce tags.',
    'Respond using the provided JSON schema.',
    '',
    input.text,
  ].join('\n');

  const res = await callOpenAICompletion({
    systemPrompt,
    prompt,
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
      tagsArray = payload;
    } else if (typeof payload === 'object' && payload !== null && 'tags' in payload) {
      tagsArray = Array.isArray((payload as { tags?: unknown }).tags)
        ? (payload as { tags: unknown[] }).tags
        : undefined;
    }

    if (tagsArray) {
      tags = tagsArray
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
        .slice(0, maxTags);
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error(
      {
        error: err.message,
        rawContentPreview: res.content.substring(0, 500),
        rawContentLength: res.content.length,
      },
      'failed to parse JSON response from LLM'
    );
  }

  return { tags };
}
