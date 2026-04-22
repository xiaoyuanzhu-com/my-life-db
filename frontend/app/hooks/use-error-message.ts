import { useTranslation } from 'react-i18next';
import { formatApiError, type ApiError } from '~/lib/errors';

/**
 * Format an ApiError into a localized string. Pass the result of
 * `parseApiError(response)` or any `{ code?, message }` pair.
 *
 * Example:
 *   const tErr = useErrorMessage();
 *   const apiErr = await parseApiError(response);
 *   toast.error(tErr(apiErr));
 */
export function useErrorMessage() {
  const { t } = useTranslation('errors');
  return (err: ApiError) => formatApiError(err, t);
}
