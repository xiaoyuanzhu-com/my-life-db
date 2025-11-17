/**
 * Message Type - categorizes what kind of content the user submitted
 *
 * Values:
 * - text: Plain text only
 * - url: Web link
 * - image: Single image (no text)
 * - audio: Audio recording
 * - video: Video file
 * - pdf: PDF document
 * - mixed: Text combined with attachments
 */
export type MessageType = 'text' | 'url' | 'image' | 'audio' | 'video' | 'pdf' | 'mixed';
