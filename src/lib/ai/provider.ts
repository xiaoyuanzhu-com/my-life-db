// AI Provider abstraction layer
// Reads from settings and routes to appropriate AI service

import { getAIConfig } from '@/lib/config/storage';
import type { AIConfig } from '@/lib/config/settings';

/**
 * Get the configured AI provider
 */
export async function getAIProvider(): Promise<AIConfig> {
  return await getAIConfig();
}

/**
 * Call AI completion endpoint based on configured provider
 */
export async function callAI(prompt: string): Promise<string> {
  const config = await getAIProvider();

  switch (config.provider) {
    case 'openai':
      return await callOpenAI(prompt, config);

    case 'ollama':
      return await callOllama(prompt, config);

    case 'custom':
      return await callCustomAPI(prompt, config);

    case 'none':
    default:
      throw new Error('No AI provider configured. Please configure in settings.');
  }
}

/**
 * Call OpenAI API
 */
async function callOpenAI(prompt: string, config: AIConfig): Promise<string> {
  if (!config.openai?.apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const baseUrl = config.openai.baseUrl || 'https://api.openai.com/v1';
  const model = config.openai.model || 'gpt-4';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openai.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant that extracts structured information from text.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || '';
}

/**
 * Call Ollama API
 */
async function callOllama(prompt: string, config: AIConfig): Promise<string> {
  if (!config.ollama?.baseUrl || !config.ollama?.model) {
    throw new Error('Ollama configuration incomplete');
  }

  const response = await fetch(`${config.ollama.baseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.ollama.model,
      prompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama API error: ${error}`);
  }

  const data = await response.json();
  return data.response || '';
}

/**
 * Call Custom API
 */
async function callCustomAPI(prompt: string, config: AIConfig): Promise<string> {
  if (!config.custom?.baseUrl) {
    throw new Error('Custom API base URL not configured');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config.custom.headers || {}),
  };

  if (config.custom.apiKey) {
    headers['Authorization'] = `Bearer ${config.custom.apiKey}`;
  }

  const response = await fetch(`${config.custom.baseUrl}/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt,
      model: config.custom.model,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Custom API error: ${error}`);
  }

  const data = await response.json();
  return data.response || data.text || '';
}

/**
 * Check if AI is configured and available
 */
export async function isAIAvailable(): Promise<boolean> {
  const config = await getAIProvider();
  return config.provider !== 'none';
}
