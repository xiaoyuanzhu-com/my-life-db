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

  try {
    const shareData: ShareData = { title: name };

    // Try to share the actual file
    try {
      const response = await fetch(`/raw/${path}`, { cache: 'force-cache' });
      if (response.ok) {
        const blob = await response.blob();
        const fileToShare = new File([blob], name, { type: mimeType || blob.type });

        if (navigator.canShare && navigator.canShare({ files: [fileToShare] })) {
          shareData.files = [fileToShare];
        } else {
          shareData.url = `/raw/${path}`;
        }
      } else {
        shareData.url = `/raw/${path}`;
      }
    } catch {
      shareData.url = `/raw/${path}`;
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
