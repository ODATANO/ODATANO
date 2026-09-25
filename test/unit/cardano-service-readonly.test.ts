import cds from '@sap/cds';
import path from 'path';

/**
 * Every entity projection of the read service must be @readonly so generic
 * CREATE/UPDATE/DELETE requests get 405 instead of writing into the cache.
 * Internal indexer writes run on the database service and are unaffected.
 */
describe('CardanoODataService — @readonly entities', () => {
  it('annotates every entity projection as @readonly', async () => {
    const csn = await cds.load(path.join(__dirname, '../../srv/cardano-service'));
    const entities = Object.entries(csn.definitions as Record<string, any>).filter(
      ([name, def]) => name.startsWith('CardanoODataService.') && def.kind === 'entity'
    );

    expect(entities.length).toBe(29);
    for (const [name, def] of entities) {
      // include the name in the assertion so a failure pinpoints the entity
      expect({ name, readonly: def['@readonly'] }).toEqual({ name, readonly: true });
    }
  });
});
