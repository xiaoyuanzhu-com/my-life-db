import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Strips IDE context tags from text, returning only the actual message content.
 * Handles: <ide_opened_file>, <ide_selection>, <system-reminder>
 * Also handles truncated tags (e.g., </ide_select…) from Claude's session index
 */
export function stripIdeContextTags(text: string): string {
  // First try complete tags
  let result = text.replace(/<(ide_opened_file|ide_selection|system-reminder)>[\s\S]*?<\/\1>/g, '')

  // Also handle truncated/incomplete tags (Claude truncates firstPrompt in session index)
  // Match opening tag followed by content until end of string (no closing tag)
  result = result.replace(/<(ide_opened_file|ide_selection|system-reminder)>[\s\S]*$/g, '')

  return result.trim()
}

/**
 * Extracts the actual user prompt from firstPrompt text.
 * Strips all system-injected tags (<ide_xxx>, <system-reminder>, etc.)
 * and returns only what the user actually typed.
 * Returns empty string if there's no actual user content.
 */
export function extractUserPrompt(text: string): string {
  if (!text) return ''

  // Strip all tags that follow the <xxx_xxx> or <xxx-xxx> pattern (system-injected)
  // This handles: ide_opened_file, ide_selection, system-reminder, etc.
  // First handle complete tags
  let result = text.replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/gi, '')

  // Also handle truncated/incomplete tags (Claude truncates firstPrompt in session index)
  result = result.replace(/<[a-z_-]+>[\s\S]*$/gi, '')

  return result.trim()
}
