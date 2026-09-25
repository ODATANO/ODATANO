import { normalizeBackendError } from './errors';
import cds, { Request } from '@sap/cds';
import { mapError } from './mappers';

const logger = cds.log('BackendRequestHandler');

/** Wraps a backend call and normalizes any thrown error to a BackendError subclass. */
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

/** Runs a service handler inside the request transaction and maps errors to OData responses. */
export async function handleRequest(
  req: Request,
  handler: (db: cds.Transaction) => Promise<unknown>):
  Promise<unknown> {
  const context = req.target?.name || req.event;
  // Managed transaction: CAP rolls back on req.reject()/req.error(), no explicit rollback.
  const db = cds.tx(req);
  try {
    return await handler(db);
  } catch (e: unknown) {
    logger.error({ err: e }, `${context} error`);
    return mapError(req, e, context);

  }
}


