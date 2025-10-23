export type InputType = 'url' | 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'file' | 'any';

export interface DetectionResult {
  type: InputType;
  confidence?: number;
}

/**
 * Detects the input type based on content and selected files
 * Client-side detection only (server detection may be added later)
 */
export async function detectInputType(
  content: string,
  files: File[]
): Promise<DetectionResult> {
  // If both content and files exist, return 'any'
  if (content.trim() && files.length > 0) {
    return { type: 'any' };
  }

  // Only files
  if (files.length > 0 && !content.trim()) {
    const fileTypes = files.map(f => getFileType(f));
    const uniqueTypes = new Set(fileTypes);

    // If all files are the same type, return that type
    if (uniqueTypes.size === 1) {
      return { type: fileTypes[0] };
    }

    // Mixed file types
    return { type: 'any' };
  }

  // Only text content
  if (content.trim()) {
    // Check for URL pattern
    const urlPattern = /^(https?:\/\/)/i;
    if (urlPattern.test(content.trim())) {
      return { type: 'url' };
    }

    return { type: 'text' };
  }

  // Empty input - return text as default
  return { type: 'text' };
}

/**
 * Determines file type based on MIME type
 */
function getFileType(file: File): InputType {
  const mimeType = file.type.toLowerCase();

  if (mimeType.startsWith('image/')) {
    return 'image';
  }

  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }

  if (mimeType.startsWith('video/')) {
    return 'video';
  }

  if (mimeType === 'application/pdf') {
    return 'pdf';
  }

  // Unknown file type
  return 'file';
}
