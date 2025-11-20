/**
 * Edge-compatible session management using signed tokens
 * Works in Next.js middleware (Edge Runtime)
 */

const ONE_YEAR_IN_MS = 365 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  createdAt: number;
  expiresAt: number;
}

/**
 * Create a signed session token
 * Format: {payload}.{signature}
 */
export async function createSessionToken(): Promise<string> {
  const now = Date.now();
  const payload: SessionPayload = {
    createdAt: now,
    expiresAt: now + ONE_YEAR_IN_MS,
  };

  const payloadStr = JSON.stringify(payload);
  const payloadB64 = btoa(payloadStr);
  const signature = await signPayload(payloadB64);

  return `${payloadB64}.${signature}`;
}

/**
 * Verify a session token
 * Returns true if valid and not expired
 */
export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    const [payloadB64, signature] = token.split('.');

    if (!payloadB64 || !signature) {
      return false;
    }

    // Verify signature
    const isValid = await verifySignature(payloadB64, signature);
    if (!isValid) {
      return false;
    }

    // Parse payload
    const payloadStr = atob(payloadB64);
    const payload: SessionPayload = JSON.parse(payloadStr);

    // Check expiration
    const now = Date.now();
    if (now > payload.expiresAt) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Sign a payload using HMAC-SHA256
 */
async function signPayload(payload: string): Promise<string> {
  const secret = getAuthSecret();
  const encoder = new TextEncoder();
  const data = encoder.encode(payload);
  const keyData = encoder.encode(secret);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, data);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * Verify a signature
 */
async function verifySignature(payload: string, signature: string): Promise<boolean> {
  const expectedSignature = await signPayload(payload);
  return signature === expectedSignature;
}

/**
 * Get auth secret from environment
 */
function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET || process.env.AUTH_PASSWORD;

  if (!secret) {
    throw new Error('AUTH_SECRET or AUTH_PASSWORD environment variable is not set');
  }

  return secret;
}
