/**
 * UUID v7 Generator
 * Generates time-sortable UUIDs with millisecond precision
 */

import { randomBytes } from 'crypto';

/**
 * Generate a UUID v7 (time-sortable)
 * Format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
 * - First 48 bits: Unix timestamp in milliseconds
 * - Next 12 bits: Random data (sub-millisecond ordering)
 * - Version bits: 0111 (v7)
 * - Variant bits: 10xx
 * - Remaining: Random data
 */
export function generateUUIDv7(): string {
  const timestamp = Date.now();
  const randomBits = randomBytes(10);

  // 48-bit timestamp (6 bytes)
  const timestampHex = timestamp.toString(16).padStart(12, '0');

  // 12-bit random data for sub-millisecond ordering
  const rand12bit = (randomBits[0] << 4) | (randomBits[1] >> 4);
  const rand12hex = rand12bit.toString(16).padStart(3, '0');

  // Version 7 (0111) + 4 bits random
  const version7 = 0x7000 | (randomBits[1] & 0x0f);
  const version7hex = version7.toString(16);

  // Variant (10) + 14 bits random
  const variant = 0x8000 | ((randomBits[2] << 6) | (randomBits[3] >> 2));
  const variantHex = variant.toString(16);

  // Remaining 48 bits random
  const remainingHex = randomBits.slice(4, 10).toString('hex');

  // Format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
  return [
    timestampHex.slice(0, 8),
    timestampHex.slice(8, 12),
    version7hex + rand12hex.slice(1),
    variantHex,
    remainingHex,
  ].join('-');
}

/**
 * Extract timestamp from UUID v7
 */
export function extractTimestampFromUUIDv7(uuid: string): number {
  const timestampHex = uuid.replace(/-/g, '').slice(0, 12);
  return parseInt(timestampHex, 16);
}
