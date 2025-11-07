/**
 * OpenAI API wrapper
 * Provides simple completion and structured JSON output
 */

import { getSettings } from '@/lib/config/storage';
import { getLogger } from '@/lib/log/logger';

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

export async function callOpenAICompletion(
  options: OpenAICompletionOptions
): Promise<OpenAICompletionResponse> {
  const settings = await getSettings();
  const vendorConfig = settings.vendors?.openai;

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

  const messages: Array<{ role: string; content: string }> = [];

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

  const requestBody: Record<string, unknown> = {
    model,
    messages,
    temperature: options.temperature ?? 0.7,
  };

  if (options.maxTokens) {
    requestBody.max_tokens = options.maxTokens;
  }

  // Enable structured JSON output if schema provided
  if (options.jsonSchema) {
    requestBody.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        strict: true,
        schema: options.jsonSchema,
      },
    };
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${vendorConfig.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  const content = data.choices?.[0]?.message?.content || '';
  const usage = data.usage ? {
    promptTokens: data.usage.prompt_tokens,
    completionTokens: data.usage.completion_tokens,
    totalTokens: data.usage.total_tokens,
  } : undefined;

  return {
    content,
    usage,
  };
}
