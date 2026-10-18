// Serves the old service path `/odata/v4/cardano-odata` as `/odata/v4/cardano` until the 2.0.0 release.
// The rewrite runs before CAP mounts the services; the standalone server and the plugin both register it.

import cds from '@sap/cds';
import type { Application, NextFunction, Request, Response } from 'express';

const logger = cds.log('ODATANO');

/** Old service path -> the path the service is mounted at. */
export const LEGACY_SERVICE_PATHS: Readonly<Record<string, string>> = {
  '/odata/v4/cardano-odata': '/odata/v4/cardano',
};

let registered = false;
// Warned once per client address, so the log names every caller still on the old path.
const warned = new Set<string>();

/** The URL on the new path, or null when it is not on an old path (`/odata/v4/cardano-odata-x` is not). */
export function rewriteLegacyServicePath(url: string): string | null {
  for (const [from, to] of Object.entries(LEGACY_SERVICE_PATHS)) {
    if (url === from || url.startsWith(from + '/') || url.startsWith(from + '?')) return to + url.slice(from.length);
  }
  return null;
}

export function legacyServicePathMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const url = rewriteLegacyServicePath(req.url);
  if (url !== null) {
    const caller = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    if (!warned.has(caller)) {
      warned.add(caller);
      logger.warn(`${caller} called ${req.url.split('?')[0]}, a deprecated service path; use ${url.split('?')[0]} (the old path goes with the 2.0.0 release)`);
    }
    const original = rewriteLegacyServicePath(req.originalUrl);
    if (original !== null) req.originalUrl = original;
    req.url = url;
  }
  next();
}

/** Once per process; the middleware goes onto the app at bootstrap, before the services are mounted. */
export function registerLegacyServicePaths(): void {
  if (registered) return;
  registered = true;
  cds.on('bootstrap', (app: Application) => {
    app.use(legacyServicePathMiddleware);
  });
}

/** Forget the first-use warnings (tests). */
export function __resetLegacyServicePathsForTests(): void {
  warned.clear();
}
