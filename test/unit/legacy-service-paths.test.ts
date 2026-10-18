import cds from '@sap/cds';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rewriteLegacyServicePath, legacyServicePathMiddleware, __resetLegacyServicePathsForTests } from '../../srv/utils/legacy-service-paths';

describe('legacy service paths', () => {
  beforeEach(() => __resetLegacyServicePathsForTests());

  it('rewrites the old read-service path and everything below it', () => {
    expect(rewriteLegacyServicePath('/odata/v4/cardano-odata')).toBe('/odata/v4/cardano');
    expect(rewriteLegacyServicePath('/odata/v4/cardano-odata/Blocks?$top=1')).toBe('/odata/v4/cardano/Blocks?$top=1');
    expect(rewriteLegacyServicePath('/odata/v4/cardano-odata?$top=1')).toBe('/odata/v4/cardano?$top=1');
  });

  it('leaves every other path alone', () => {
    expect(rewriteLegacyServicePath('/odata/v4/cardano/Blocks')).toBeNull();
    expect(rewriteLegacyServicePath('/odata/v4/cardano-odata-x/Blocks')).toBeNull();
    expect(rewriteLegacyServicePath('/odata/v4/cardano-transaction/Blocks')).toBeNull();
    expect(rewriteLegacyServicePath('/')).toBeNull();
  });

  it('moves url and originalUrl of a request on the old path', () => {
    const req = { url: '/odata/v4/cardano-odata/Blocks', originalUrl: '/odata/v4/cardano-odata/Blocks' };
    let called = false;
    legacyServicePathMiddleware(req as never, {} as never, () => { called = true; });
    expect(called).toBe(true);
    expect(req).toEqual({ url: '/odata/v4/cardano/Blocks', originalUrl: '/odata/v4/cardano/Blocks' });

    const other = { url: '/odata/v4/cardano-sign/x', originalUrl: '/odata/v4/cardano-sign/x' };
    legacyServicePathMiddleware(other as never, {} as never, () => {});
    expect(other.url).toBe('/odata/v4/cardano-sign/x');
  });

  it('warns once per client address', () => {
    const warn = vi.spyOn(cds.log('ODATANO'), 'warn').mockImplementation(() => undefined);
    const hit = (ip: string) => legacyServicePathMiddleware({ url: '/odata/v4/cardano-odata/Blocks', originalUrl: '/odata/v4/cardano-odata/Blocks', ip } as never, {} as never, () => {});
    hit('10.0.0.1');
    hit('10.0.0.1');
    hit('10.0.0.2');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('10.0.0.1 called /odata/v4/cardano-odata/Blocks');
    expect(String(warn.mock.calls[1][0])).toContain('10.0.0.2 called');
    warn.mockRestore();
  });
});
