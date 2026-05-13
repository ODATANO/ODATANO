import { normalizeBackendError } from './errors';
import cds, { Request } from '@sap/cds';
import { mapError } from './mappers';

const logger = cds.log('BackendRequestHandler');

/** 
 * BackendRequestHandler - Provides standardized handling for backend requests 
 */

/** 
 * BackendRequestHandler - Wraps a backend method call with standardized error handling
 * @param fn - The async function to execute
 * @param backendName - Name of the backend (for error context)
 * @param resourceName - Name of the resource being accessed (e.g., "Transaction", "Address")
 * @returns {Promise<T>} The result of the backend call or a normalized error
 */
export async function handleBackendRequest<T>(
  fn: () => Promise<T>,
  backendName: string
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    throw normalizeBackendError(err, backendName);
  }
}

/**
 * General request handler for CardanoService
 * @param req - The incoming request
 * @param handler - The async function containing business logic
 * @returns {Promise<unknown>} The result of the handler or a mapped error response
 */
export async function handleRequest(
  req: Request,
  handler: (db: cds.Transaction) => Promise<unknown>):
  Promise<unknown> {
  const context = req.target?.name || req.event;
  // cds.tx(req) returns the request's managed transaction — CAP auto-rolls back
  // on req.reject()/req.error() (called by mapError). No explicit rollback needed.
  const db = cds.tx(req);
  try {
    return await handler(db);
  } catch (e: unknown) {
    logger.error({ err: e }, `${context} error`);
    return mapError(req, e, context);

  }
}


