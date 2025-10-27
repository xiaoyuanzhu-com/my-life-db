/**
 * Homelab AI (homelab-ai-in-docker) API wrapper
 * Provides image captioning using local AI models
 */

import { getSettings } from '@/lib/config/storage';
import { readFileSync } from 'fs';

export interface HomelabAIImageCaptionOptions {
  imagePath?: string; // Path to local image file
  imageBase64?: string; // Or base64-encoded image directly
  model?: string;
  prompt?: string;
}

export interface HomelabAIImageCaptionResponse {
  caption: string;
  model: string;
}

/**
 * Generate image caption using homelab-ai-in-docker service
 *
 * @param options - Image captioning options
 * @returns Caption and model info
 *
 * @example
 * // From file path
 * const result = await captionImage({
 *   imagePath: '/path/to/image.jpg',
 *   prompt: 'Describe this image in detail.'
 * });
 *
 * @example
 * // From base64 string
 * const result = await captionImage({
 *   imageBase64: 'iVBORw0KGgo...',
 *   prompt: 'What objects are in this image?'
 * });
 */
export async function captionImage(
  options: HomelabAIImageCaptionOptions
): Promise<HomelabAIImageCaptionResponse> {
  const settings = await getSettings();
  const vendorConfig = settings.vendors?.homelabAi;

  const baseUrl = vendorConfig?.baseUrl || 'https://haid.home.iloahz.com';
  const model = options.model || 'unsloth/llava-v1.6-mistral-7b-hf-bnb-4bit';
  const prompt = options.prompt || 'USER: <image>\nDescribe this image in detail.\nASSISTANT:';

  // Get base64 image data
  let imageBase64: string;

  if (options.imageBase64) {
    imageBase64 = options.imageBase64;
  } else if (options.imagePath) {
    // Read file and convert to base64
    const imageBuffer = readFileSync(options.imagePath);
    imageBase64 = imageBuffer.toString('base64');
  } else {
    throw new Error('Either imagePath or imageBase64 must be provided');
  }

  const response = await fetch(`${baseUrl}/api/image-captioning`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image: imageBase64,
      model,
      prompt,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Homelab AI API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // The API response format may vary - adjust based on actual response
  // Assuming it returns { caption: "...", model: "..." }
  const caption = data.caption || data.response || data.text || '';

  return {
    caption,
    model,
  };
}
