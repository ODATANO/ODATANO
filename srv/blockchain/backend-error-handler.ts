import { normalizeBackendError, BackendError } from '../utils/errors';

/**
 * Wraps a backend method call with standardized error handling
 * 
 * @param fn - The async function to execute
 * @param backendName - Name of the backend (for error context)
 * @param resourceName - Name of the resource being accessed (e.g., "Transaction", "Address")
 * @returns The result of the function or throws a normalized BackendError
 */
export async function handleBackendError<T>(
  fn: () => Promise<T>,
  backendName: string,
  resourceName?: string
): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    throw normalizeBackendError(err, backendName, resourceName);
  }
}
