import 'server-only';
// File deduplication utilities (macOS/Linux style)
import fs from 'fs/promises';
import path from 'path';

/**
 * Generate a unique filename by appending a space and number suffix
 * Follows macOS/Linux convention: file.txt -> file 2.txt -> file 3.txt
 *
 * @param directory - Directory to check for existing files
 * @param filename - Original filename
 * @returns Promise<string> - Unique filename
 *
 * @example
 * await getUniqueFilename('/inbox/uuid', 'photo.jpg')
 * // Returns 'photo.jpg' if doesn't exist
 * // Returns 'photo 2.jpg' if 'photo.jpg' exists
 * // Returns 'photo 3.jpg' if both 'photo.jpg' and 'photo 2.jpg' exist
 */
export async function getUniqueFilename(
  directory: string,
  filename: string
): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  let candidate = filename;
  let counter = 2;

  // Check if file exists, increment counter until we find a unique name
  while (await fileExists(path.join(directory, candidate))) {
    candidate = `${base} ${counter}${ext}`;
    counter++;
  }

  return candidate;
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get unique filenames for multiple files
 * Handles the case where the array itself contains duplicates
 *
 * @example
 * await getUniqueFilenames('/inbox/uuid', ['photo.jpg', 'photo.jpg', 'doc.pdf'])
 * // Returns ['photo.jpg', 'photo 2.jpg', 'doc.pdf']
 */
export async function getUniqueFilenames(
  directory: string,
  filenames: string[]
): Promise<string[]> {
  const uniqueNames: string[] = [];
  const seen = new Set<string>();

  for (const filename of filenames) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);

    let candidate = filename;
    let counter = 2;

    // Check both filesystem AND already processed names in this batch
    while (
      (await fileExists(path.join(directory, candidate))) ||
      seen.has(candidate)
    ) {
      candidate = `${base} ${counter}${ext}`;
      counter++;
    }

    uniqueNames.push(candidate);
    seen.add(candidate);
  }

  return uniqueNames;
}
