import cds from '@sap/cds';
import path from 'path';

/**
 * Guard for the cache-poisoning fix: every entity projection of the read service
 * must be @readonly so generic CREATE/UPDATE/DELETE requests are rejected with 405
 * (CAP's check_readonly generic handler) instead of writing into the cache that is
 * then served as "blockchain data".
 *
 * Internal indexer writes are unaffected: they run on cds.tx(req) — the database
 * service — which does not carry application-service generic handlers (and the
 * UPSERT event is not in CAP's WRITE_EVENTS to begin with).
 */
describe('CardanoODataService — @readonly entities', () => {
  it('annotates every entity projection as @readonly', async () => {
    const csn = await cds.load(path.join(__dirname, '../../srv/cardano-service'));
    const entities = Object.entries(csn.definitions as Record<string, any>).filter(
      ([name, def]) => name.startsWith('CardanoODataService.') && def.kind === 'entity'
    );

    expect(entities.length).toBe(20);
    for (const [name, def] of entities) {
      // include the name in the assertion so a failure pinpoints the entity
      expect({ name, readonly: def['@readonly'] }).toEqual({ name, readonly: true });
    }
  });
});
