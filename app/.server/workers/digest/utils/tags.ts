
import { callOpenAICompletion } from '~/.server/vendors/openai';
import { getLogger } from '~/.server/log/logger';
import { loadSettings } from '~/.server/config/storage';
import { getNativeLanguageDisplayName } from '~/lib/i18n/languages';
import { parseJsonFromLlmResponse } from './parse-json';

const log = getLogger({ module: 'TagsDigester' });

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

  // JSON schema for models that support structured output
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

  // Build the system prompt with language requirements
  let systemPrompt: string;
  if (languages.length === 1) {
    systemPrompt = [
      'You are an expert knowledge organizer.',
      `Generate 5-10 tags in ${languageNames[0]} that help classify the content.`,
      'Tag format: lowercase with spaces (e.g., "open source"), but honor conventions for proper nouns (e.g., "iOS", "JavaScript").',
      'No hashtags or numbering.',
      'Respond with JSON in format: {"tags": ["tag1", "tag2", ...]}',
    ].join(' ');
  } else {
    systemPrompt = [
      'You are an expert knowledge organizer.',
      `Generate tags in EACH of these languages: ${languageNames.join(', ')}.`,
      'Generate 5-10 tags PER language - the output should contain tags in ALL listed languages.',
      'Tags across languages should have similar meanings, but semantic variations are fine if no direct equivalent exists.',
      'Tag format: lowercase with spaces (e.g., "open source", "机器学习"), but honor conventions for proper nouns (e.g., "iOS", "JavaScript").',
      'No hashtags or numbering.',
      'Respond with JSON in format: {"tags": ["tag1", "tag2", "标签1", "标签2", ...]}',
    ].join(' ');
  }

  const prompt = [
    'Analyze the following content and produce tags.',
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
    const payload = parseJsonFromLlmResponse(res.content) as { tags?: unknown };

    if (payload && typeof payload === 'object' && 'tags' in payload && Array.isArray(payload.tags)) {
      tags = payload.tags
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
