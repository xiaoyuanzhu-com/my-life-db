/**
 * OpenAI API wrapper
 * Provides simple completion and structured JSON output
 */

import OpenAI from 'openai';
import { getSettings } from '@/lib/config/storage';
import { getLogger } from '@/lib/log/logger';
import type { UserSettings } from '@/lib/config/settings';

export interface OpenAICompletionOptions {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonSchema?: Record<string, unknown>; // JSON Schema for structured output
}

export interface OpenAICompletionResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface OpenAIEmbeddingOptions {
  input: string | string[];
  model?: string;
}

export interface OpenAIEmbeddingResponse {
  embeddings: number[][];
  model: string;
  usage?: {
    promptTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Call OpenAI completion API with text input and get text or structured JSON output
 *
 * @param options - Completion options
 * @returns Completion response with content and usage stats
 *
 * @example
 * // Simple text completion
 * const result = await callOpenAICompletion({
 *   prompt: "What is the capital of France?"
 * });
 *
 * @example
 * // Structured JSON output
 * const result = await callOpenAICompletion({
 *   prompt: "Extract the person's name and age from: 'John is 30 years old'",
 *   jsonSchema: {
 *     type: "object",
 *     properties: {
 *       name: { type: "string" },
 *       age: { type: "number" }
 *     },
 *     required: ["name", "age"],
 *     additionalProperties: false
 *   }
 * });
 * // result.content will be valid JSON: {"name": "John", "age": 30}
 */
const log = getLogger({ module: 'VendorOpenAI' });

function getVendorOpenAIConfig(settings: UserSettings) {
  return settings.vendors?.openai;
}

export async function callOpenAICompletion(
  options: OpenAICompletionOptions
): Promise<OpenAICompletionResponse> {
  const settings = await getSettings();
  const vendorConfig = getVendorOpenAIConfig(settings);

  if (!vendorConfig?.apiKey) {
    throw new Error('OpenAI API key not configured in settings');
  }

  const baseUrl = vendorConfig.baseUrl || 'https://api.openai.com/v1';
  const optionModel = typeof options.model === 'string' ? options.model.trim() : undefined;
  const vendorModel = typeof vendorConfig.model === 'string' ? vendorConfig.model.trim() : undefined;
  const fallbackModel = 'gpt-4o-mini';
  const model = optionModel || vendorModel || fallbackModel;

  try {
    log.info(
      {
        optionModel: optionModel || null,
        vendorModel: vendorModel || null,
        fallbackModel,
        selectedModel: model,
        baseUrl,
      },
      'openai completion model selection'
    );
  } catch {}

  // Initialize OpenAI client
  const client = new OpenAI({
    baseURL: baseUrl,
    apiKey: vendorConfig.apiKey,
    defaultHeaders: {
      'X-Title': 'MyLifeDB',
      'HTTP-Referer': 'https://github.com/xiaoyuanzhu-com/my-life-db',
    },
  });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  if (options.systemPrompt) {
    messages.push({
      role: 'system',
      content: options.systemPrompt,
    });
  }

  messages.push({
    role: 'user',
    content: options.prompt,
  });

  const requestParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    temperature: options.temperature ?? 0.7,
  };

  if (options.maxTokens) {
    requestParams.max_completion_tokens = options.maxTokens;
  }

  // Enable structured JSON output if schema provided
  if (options.jsonSchema) {
    // Try json_schema first (strict mode for OpenAI models)
    // Some models (like MiniMax) may not support this and will ignore it
    // or treat it like json_object mode (which doesn't enforce schema)
    requestParams.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        strict: true,
        schema: options.jsonSchema,
      },
    };
  }

  let response;
  try {
    response = await client.chat.completions.create(requestParams);
  } catch (error) {
    // Log detailed error context for debugging
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(
      {
        error: errorMessage,
        model,
        temperature: requestParams.temperature,
        hasJsonSchema: !!options.jsonSchema,
        systemPromptLength: options.systemPrompt?.length || 0,
        promptLength: options.prompt.length,
        promptPreview: options.prompt.substring(0, 200),
        maxTokens: options.maxTokens,
      },
      'openai api call failed'
    );
    throw error;
  }

  const message = response.choices?.[0]?.message;
  const finishReason = response.choices?.[0]?.finish_reason;

  // Some models (like MiniMax reasoning models) may put content in 'reasoning' field
  // or may use 'content' field. Try both.
  let content = message?.content || '';

  // If content is empty but reasoning exists, the model may have hit token limit during reasoning
  // @ts-expect-error - reasoning field may exist on some models
  if (!content && message?.reasoning) {
    // @ts-expect-error - reasoning field may exist on some models
    const reasoning = message.reasoning as string;
    console.warn('[VendorOpenAI] Content is empty but reasoning field exists. This may indicate the response was truncated.', {
      finishReason,
      reasoningLength: reasoning.length,
      reasoningPreview: reasoning.substring(0, 200),
    });

    // Try to extract JSON from reasoning as last resort
    content = reasoning;
  }

  // Warn if response was truncated due to length
  if (finishReason === 'length') {
    console.warn('[VendorOpenAI] Response was truncated due to max_tokens limit', {
      maxTokens: options.maxTokens,
      completionTokens: response.usage?.completion_tokens,
      finishReason,
    });
  }

  const usage = response.usage ? {
    promptTokens: response.usage.prompt_tokens,
    completionTokens: response.usage.completion_tokens,
    totalTokens: response.usage.total_tokens,
  } : undefined;

  return {
    content,
    usage,
  };
}

export async function isOpenAIConfigured(): Promise<boolean> {
  const settings = await getSettings();
  const vendorConfig = getVendorOpenAIConfig(settings);
  return Boolean(vendorConfig?.apiKey?.trim());
}

export async function callOpenAIEmbedding(
  options: OpenAIEmbeddingOptions
): Promise<OpenAIEmbeddingResponse> {
  const settings = await getSettings();
  const vendorConfig = getVendorOpenAIConfig(settings);

  if (!vendorConfig?.apiKey) {
    throw new Error('OpenAI API key not configured in settings');
  }

  const baseUrl = vendorConfig.baseUrl || 'https://api.openai.com/v1';
  const fallbackModel = 'text-embedding-3-small';
  const model = options.model || vendorConfig.embeddingModel || fallbackModel;

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${vendorConfig.apiKey}`,
      'X-Title': 'MyLifeDB',
      'HTTP-Referer': 'https://github.com/xiaoyuanzhu-com/my-life-db',
    },
    body: JSON.stringify({
      model,
      input: options.input,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI embedding error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const embeddings = (data?.data ?? []).map((item: { embedding: number[] }) => item.embedding);

  return {
    embeddings,
    model,
    usage: data?.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
  };
}
