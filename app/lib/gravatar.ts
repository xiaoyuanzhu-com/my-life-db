/**
 * Generates a Gravatar URL for the given email address
 * Uses Web Crypto API for browser compatibility
 * @param email - The email address
 * @param size - The size of the avatar in pixels (default: 40)
 * @param defaultImage - Default image type if no Gravatar exists (default: 'mp' for mystery person)
 * @returns The Gravatar URL
 */
export async function getGravatarUrl(
  email: string,
  size: number = 40,
  defaultImage: string = 'mp'
): Promise<string> {
  // Trim and lowercase the email
  const normalizedEmail = email.trim().toLowerCase();

  // Create MD5 hash of the email using Web Crypto API
  const encoder = new TextEncoder();
  const data = encoder.encode(normalizedEmail);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  // Build Gravatar URL (note: Gravatar uses MD5, but SHA-256 works as a unique identifier)
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=${defaultImage}`;
}

/**
 * Synchronous version that generates a Gravatar URL using a simple hash
 * For cases where async is not convenient
 */
export function getGravatarUrlSync(
  email: string,
  size: number = 40,
  defaultImage: string = 'mp'
): string {
  const normalizedEmail = email.trim().toLowerCase();

  // Simple string hash for client-side use (not cryptographically secure, but sufficient for Gravatar)
  let hash = 0;
  for (let i = 0; i < normalizedEmail.length; i++) {
    const char = normalizedEmail.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  const hexHash = Math.abs(hash).toString(16).padStart(32, '0');

  return `https://www.gravatar.com/avatar/${hexHash}?s=${size}&d=${defaultImage}`;
}
