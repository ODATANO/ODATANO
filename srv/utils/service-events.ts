import cds from '@sap/cds';

const logger = cds.log('ServiceEvents');

/**
 * Mirror an internal notification onto a CAP service as a declared event, so
 * consumers can subscribe instead of polling:
 *
 *   const worker = await cds.connect.to('CardanoWorkerService');
 *   worker.on('jobConfirmed', ({ data }) => …);
 *
 * ODATANO ships as a CAP plugin, so a consumer runs in the SAME process — these
 * events therefore need no broker and no `cds.requires.messaging`. Configuring a
 * messaging service later routes the very same emits through it (with the CAP
 * outbox) without a change here.
 *
 * Three properties this helper guarantees, because every caller is a background
 * loop that must not be disturbed by an observer:
 *  - **Never throws.** A missing service, a rejected emit or a broken subscriber
 *    is logged and swallowed; the crawler/worker carries on.
 *  - **Never blocks.** Emission is fire-and-forget; a slow subscriber cannot stall
 *    block ingestion.
 *  - **Silent when unserved.** In unit tests and before CAP's `served` phase the
 *    service simply does not exist yet — that is normal, not an error.
 *
 * Call sites must emit AFTER their transaction commits: an event that names data
 * a subscriber cannot read yet is worse than no event.
 */
export function emitServiceEvent(serviceName: string, event: string, data: Record<string, unknown>): void {
  const srv = (cds.services as Record<string, { emit?: (e: string, d: unknown) => Promise<unknown> } | undefined>)?.[serviceName];
  if (!srv?.emit) return; // not served (unit tests, standalone boot) — nothing to notify

  try {
    void Promise.resolve(srv.emit(event, data)).catch((err) => {
      logger.warn(`${serviceName}.${event} subscriber failed (ignored):`, err);
    });
  } catch (err) {
    logger.warn(`${serviceName}.${event} could not be emitted (ignored):`, err);
  }
}
