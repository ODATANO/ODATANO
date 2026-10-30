import cds from '@sap/cds';

const logger = cds.log('ServiceEvents');

// Emits a CAP service event in-process. Never throws and is silent before the service is served.
// Callers must emit after their transaction commits.
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
