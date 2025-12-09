import 'server-only';
/**
 * Digest Layer - Image OCR
 * Placeholder interface. Real OCR (text extraction) will be wired later.
 */

export interface ImageOcrInput {
  imagePath?: string; // path to local image
  imageBase64?: string; // or base64 image
}

export interface ImageOcrOutput {
  text: string; // extracted text
}

export async function extractTextFromImageDigest(_: ImageOcrInput): Promise<ImageOcrOutput> {
  // Placeholder implementation until OCR vendor is integrated
  return { text: '[ocr-placeholder] not implemented yet' };
}

