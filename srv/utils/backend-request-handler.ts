import { normalizeBackendError } from './errors';
import cds, { Request } from '@sap/cds';
import logger from './logger';
import { mapError } from './mappers';
/**
 * Wraps a backend method call with standardized error handling
 * 
 * @param fn - The async function to execute
 * @param backendName - Name of the backend (for error context)
 * @param resourceName - Name of the resource being accessed (e.g., "Transaction", "Address")
 * @returns The result of the function or throws a normalized BackendError
 */
export async function handleBackendRequest<T>(
  fn: () => Promise<T>,
  backendName: string
): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    throw normalizeBackendError(err, backendName);
  }
}
/** * General request handler for CardanoService
 * 
 * @param req - The incoming request 
 * @param handler - The async function containing business logic
 * @returns The result of the handler or a mapped error response
 */ 
export async function handleRequest(
    req: Request,
    handler: (db: any) => Promise<any>
  ): Promise<any> {
    const context = req.target?.name || req.event;
    const db = cds.tx(req);
    try {
      return await handler(db);
    } catch (e: any) {
      // 404 errors are expected - log as debug, not error
      if (e?.statusCode === 404) {
        logger.debug({ err: e }, `[CardanoService] ${context} - resource not found`);
      } else {
        logger.error({ err: e }, `[CardanoService] ${context} error`);
      }
      return mapError(req, e, context);
    }
  }


