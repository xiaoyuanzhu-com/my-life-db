/**
 * Utility functions for transcript processing
 */

/**
 * Clean up raw transcript by removing filler words, fixing punctuation, and improving capitalization
 * This is a fast, regex-based cleanup that runs locally without API calls
 */
export function cleanupTranscript(text: string): string {
  if (!text) return '';

  let cleaned = text;

  // Remove filler words (case insensitive)
  const fillerWords = /\b(um|uh|like|you know|i mean|sort of|kind of|actually|basically|literally)\b/gi;
  cleaned = cleaned.replace(fillerWords, '');

  // Remove repeated words (e.g., "the the" → "the")
  cleaned = cleaned.replace(/\b(\w+)\s+\1\b/gi, '$1');

  // Fix spacing around punctuation
  cleaned = cleaned.replace(/\s+([,.!?;:])/g, '$1'); // Remove space before punctuation
  cleaned = cleaned.replace(/([,.!?;:])\s*/g, '$1 '); // Ensure space after punctuation

  // Fix common contractions that ASR might split
  cleaned = cleaned.replace(/can not\b/gi, "can't");
  cleaned = cleaned.replace(/will not\b/gi, "won't");
  cleaned = cleaned.replace(/shall not\b/gi, "shan't");

  // Fix common ASR errors (homophones)
  const commonErrors: Record<string, string> = {
    'your welcome': "you're welcome",
    'should of': 'should have',
    'could of': 'could have',
    'would of': 'would have',
    'must of': 'must have',
    'there doing': "they're doing",
    'there going': "they're going",
    'your right': "you're right",
    'your wrong': "you're wrong",
    'its a': "it's a",
    'its been': "it's been",
    'thats': "that's",
  };

  for (const [wrong, right] of Object.entries(commonErrors)) {
    const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
    cleaned = cleaned.replace(regex, right);
  }

  // Capitalize first letter of sentences
  cleaned = cleaned.replace(/(^|[.!?]\s+)([a-z])/g, (match, punctuation, letter) =>
    punctuation + letter.toUpperCase()
  );

  // Capitalize "I" when used as pronoun
  cleaned = cleaned.replace(/\bi\b/g, 'I');

  // Normalize whitespace (collapse multiple spaces, trim)
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Ensure text ends with punctuation
  if (cleaned && !/[.!?]$/.test(cleaned)) {
    cleaned += '.';
  }

  return cleaned;
}

/**
 * Format duration in MM:SS format
 */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get time ago string (e.g., "2 minutes ago")
 */
export function timeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  return 'just now';
}
