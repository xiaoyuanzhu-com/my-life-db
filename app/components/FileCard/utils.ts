import type { FileWithDigests } from '~/types/file-card';
import type { FileContentType } from './types';

// =============================================================================
// Content Type Detection
// =============================================================================

/**
 * Get file extension from filename (lowercase, without dot)
 */
export function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filename.length - 1) return '';
  return filename.slice(lastDot + 1).toLowerCase();
}

/**
 * Check if MIME type or extension indicates a Word document
 */
function isWordDocument(mimeType: string, ext: string): boolean {
  const wordMimes = [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];
  const wordExts = ['doc', 'docx'];
  return wordMimes.includes(mimeType) || wordExts.includes(ext);
}

/**
 * Check if MIME type or extension indicates a PowerPoint presentation
 */
function isPowerPoint(mimeType: string, ext: string): boolean {
  const pptMimes = [
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ];
  const pptExts = ['ppt', 'pptx'];
  return pptMimes.includes(mimeType) || pptExts.includes(ext);
}

/**
 * Check if MIME type or extension indicates an Excel spreadsheet
 */
function isExcel(mimeType: string, ext: string): boolean {
  const xlsMimes = [
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];
  const xlsExts = ['xls', 'xlsx'];
  return xlsMimes.includes(mimeType) || xlsExts.includes(ext);
}

/**
 * Check if MIME type or extension indicates an EPUB eBook
 */
function isEpub(mimeType: string, ext: string): boolean {
  return mimeType === 'application/epub+zip' || ext === 'epub';
}

/**
 * Determine the content type of a file for card/modal dispatch
 * Priority: MIME type > Extension > textPreview > fallback
 */
export function getFileContentType(file: FileWithDigests): FileContentType {
  const mimeType = file.mimeType || '';
  const ext = getExtension(file.name);

  // 1. Media types (by MIME)
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';

  // 2. Document types (by MIME or extension)
  if (mimeType === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (isWordDocument(mimeType, ext)) return 'doc';
  if (isPowerPoint(mimeType, ext)) return 'ppt';
  if (isExcel(mimeType, ext)) return 'xls';
  if (isEpub(mimeType, ext)) return 'epub';

  // 3. Text content (has preview)
  if (file.textPreview) return 'text';

  // 4. Fallback
  return 'fallback';
}

// =============================================================================
// Formatting Utilities
// =============================================================================

/**
 * Format file size in human-readable format
 * Examples: 5KB, 14.3MB, 20GB, 20.4GB (max 1 decimal precision)
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  // Use 1 decimal place only if needed (not a whole number)
  const formatted = value % 1 === 0 ? value.toString() : value.toFixed(1);
  return `${formatted}${units[i]}`;
}

/**
 * Get visual weight of a character
 * English letters and digits: weight 2
 * Others (CJK, etc.): weight 3
 */
function getCharWeight(char: string): number {
  return /[a-zA-Z0-9]/.test(char) ? 2 : 3;
}

/**
 * Get total visual weight of a string
 */
function getStringWeight(str: string): number {
  let weight = 0;
  for (const char of str) {
    weight += getCharWeight(char);
  }
  return weight;
}

/**
 * Truncate string in the middle with ellipsis, using visual weight
 * English/digits: weight 2, others (CJK): weight 3
 * Max total weight: 32
 * Example: "very-long-filename.pdf" → "very-l...me.pdf"
 */
export function truncateMiddle(str: string, maxWeight: number = 42): string {
  const ellipsis = '...';
  const ellipsisWeight = ellipsis.length * 2; // 6

  if (getStringWeight(str) <= maxWeight) return str;

  const targetWeight = maxWeight - ellipsisWeight;
  const halfWeight = targetWeight / 2;

  // Build front part
  let front = '';
  let frontWeight = 0;
  for (const char of str) {
    const charWeight = getCharWeight(char);
    if (frontWeight + charWeight > halfWeight) break;
    front += char;
    frontWeight += charWeight;
  }

  // Build back part (from end)
  let back = '';
  let backWeight = 0;
  for (let i = str.length - 1; i >= 0; i--) {
    const char = str[i];
    const charWeight = getCharWeight(char);
    if (backWeight + charWeight > halfWeight) break;
    back = char + back;
    backWeight += charWeight;
  }

  return front + ellipsis + back;
}

// =============================================================================
// File Operations (Pure Functions)
// =============================================================================

/**
 * Download a file by creating a temporary link
 */
export function downloadFile(path: string, filename: string): void {
  const link = document.createElement('a');
  link.href = `/raw/${path}`;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Check if Web Share API is available
 */
export function canShare(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.share;
}

/**
 * Share a file using Web Share API
 */
export async function shareFile(
  path: string,
  name: string,
  mimeType?: string | null
): Promise<void> {
  if (!navigator.share) {
    console.error('Web Share API not supported');
    return;
  }

  // Build absolute URL for sharing
  const absoluteUrl = `${window.location.origin}/raw/${path}`;

  try {
    const shareData: ShareData = { title: name };

    // Try to share the actual file (works on mobile, not on desktop Chrome)
    try {
      const response = await fetch(`/raw/${path}`, { cache: 'force-cache' });
      if (response.ok) {
        const blob = await response.blob();
        const fileToShare = new File([blob], name, { type: mimeType || blob.type });

        if (navigator.canShare && navigator.canShare({ files: [fileToShare] })) {
          shareData.files = [fileToShare];
        } else {
          // Fallback to URL sharing (desktop Chrome)
          shareData.url = absoluteUrl;
        }
      } else {
        shareData.url = absoluteUrl;
      }
    } catch {
      shareData.url = absoluteUrl;
    }

    await navigator.share(shareData);
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      console.error('Failed to share:', error);
    }
  }
}

/**
 * Share text content using Web Share API
 */
export async function shareText(title: string, text: string): Promise<void> {
  if (!navigator.share) {
    console.error('Web Share API not supported');
    return;
  }

  try {
    await navigator.share({ title, text });
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      console.error('Failed to share:', error);
    }
  }
}

// =============================================================================
// API Calls
// =============================================================================

/**
 * Toggle pin status for a file
 * Returns true if successful
 */
export async function togglePin(path: string): Promise<boolean> {
  try {
    const response = await fetch('/api/library/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    return response.ok;
  } catch (error) {
    console.error('Failed to toggle pin:', error);
    return false;
  }
}

/**
 * Delete a file
 * Returns true if successful
 */
export async function deleteFile(path: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/library/file?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
    return response.ok;
  } catch (error) {
    console.error('Failed to delete file:', error);
    return false;
  }
}

/**
 * Fetch full text content of a file
 */
export async function fetchFullContent(path: string): Promise<string | null> {
  try {
    const response = await fetch(`/raw/${path}`);
    if (response.ok) {
      return await response.text();
    }
  } catch (error) {
    console.error('Failed to load full content:', error);
  }
  return null;
}

/**
 * Save file content
 * Returns true if successful
 */
export async function saveFileContent(path: string, content: string): Promise<boolean> {
  try {
    const response = await fetch(`/raw/${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: content,
    });
    return response.ok;
  } catch (error) {
    console.error('Failed to save file:', error);
    return false;
  }
}

// =============================================================================
// Device Detection
// =============================================================================

/**
 * Check if the current device has touch capability
 */
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' &&
    ('ontouchstart' in window || navigator.maxTouchPoints > 0);
}

// =============================================================================
// URL Helpers
// =============================================================================

/**
 * Get the library URL for opening a file
 */
export function getFileLibraryUrl(path: string): string {
  return `/library?open=${encodeURIComponent(path)}`;
}

/**
 * Get the raw file URL
 */
export function getRawFileUrl(path: string): string {
  return `/raw/${path}`;
}

/**
 * Get the content URL for a file (supports local blob URLs for pending uploads)
 */
export function getFileContentUrl(file: FileWithDigests): string {
  return file.blobUrl || `/raw/${file.path}`;
}

/**
 * Get the sqlar URL for a screenshot
 */
export function getSqlarUrl(sqlarName: string): string {
  return `/sqlar/${sqlarName
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')}`;
}

/**
 * Get screenshot URL from file digests
 */
export function getScreenshotUrl(file: FileWithDigests): string | null {
  const sqlarName = file.screenshotSqlar || file.digests?.find(
    d => d.type.includes('screenshot') && d.status === 'completed' && d.sqlarName
  )?.sqlarName;

  if (sqlarName) {
    return getSqlarUrl(sqlarName);
  }
  return null;
}
