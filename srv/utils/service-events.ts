import cds from '@sap/cds';

const logger = cds.log('ServiceEvents');

/**
 * Emits a declared CAP service event in-process (no broker needed). Never throws, never blocks,
 * silent when the service is not served yet. Callers must emit AFTER their transaction commits.
 */
export function emitServiceEvent(serviceName: string, event: string, data: Record<string, unknown>): void {
  const srv = (cds.services as Record<string, { emit?: (e: string, d: unknown) => Promise<unknown> } | undefined>)?.[serviceName];
  if (!srv?.emit) return; // not served yet

  try {
    void Promise.resolve(srv.emit(event, data)).catch((err) => {
      logger.warn(`${serviceName}.${event} subscriber failed (ignored):`, err);
    });
  } catch (err) {
    logger.warn(`${serviceName}.${event} could not be emitted (ignored):`, err);
  }
}
