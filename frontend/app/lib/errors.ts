import i18n from '~/lib/i18n/config';

/** Shape emitted by RespondCoded and the legacy flat shape. */
export interface ApiError {
  code?: string;
  message: string;
}

/**
 * Read an error response body and normalize both the new envelope
 * ({ error: { code, message } }) and the legacy shape
 * ({ error: "string" }) into a single ApiError.
 */
export async function parseApiError(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.clone().json();
  } catch {
    // Non-JSON body (HTML, empty, etc.) — fall through
  }

  // New envelope: { error: { code, message, details? } }
  if (
    body &&
    typeof body === 'object' &&
    'error' in body &&
    body.error &&
    typeof body.error === 'object' &&
    'message' in body.error
  ) {
    const err = body.error as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }

  // Legacy flat: { error: "string" }
  if (body && typeof body === 'object' && 'error' in body && typeof (body as Record<string, unknown>).error === 'string') {
    return { message: (body as Record<string, unknown>).error as string };
  }

  // Nothing usable — fall back to status text
  return { message: response.statusText || 'Request failed' };
}

/**
 * Translate an ApiError via the `errors` namespace, falling back to the
 * backend's English `message` when the code is missing or untranslated.
 * Accepts a `t` function from useTranslation (preferred inside components)
 * or falls back to the i18n singleton for use outside render paths.
 */
export function formatApiError(
  err: ApiError,
  t?: (key: string, opts?: { defaultValue: string }) => string
): string {
  const translator = t ?? ((key: string, opts?: { defaultValue: string }) => i18n.t(key, opts));
  if (err.code) {
    return translator(`errors:${err.code}`, { defaultValue: err.message });
  }
  return err.message;
}
