/**
 * File Type - broad categorization of file content
 *
 * Values:
 * - text: Text-based files (.txt, .md, etc.)
 * - image: Image files (.jpg, .png, etc.)
 * - audio: Audio files (.mp3, .wav, etc.)
 * - video: Video files (.mp4, .mov, etc.)
 * - pdf: PDF documents
 * - other: All other file types
 */
export type FileType = 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'other';
