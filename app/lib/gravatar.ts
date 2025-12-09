import crypto from 'crypto';

/**
 * Generates a Gravatar URL for the given email address
 * @param email - The email address
 * @param size - The size of the avatar in pixels (default: 40)
 * @param defaultImage - Default image type if no Gravatar exists (default: 'mp' for mystery person)
 * @returns The Gravatar URL
 */
export function getGravatarUrl(
  email: string,
  size: number = 40,
  defaultImage: string = 'mp'
): string {
  // Trim and lowercase the email
  const normalizedEmail = email.trim().toLowerCase();

  // Create MD5 hash of the email
  const hash = crypto.createHash('md5').update(normalizedEmail).digest('hex');

  // Build Gravatar URL
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=${defaultImage}`;
}
