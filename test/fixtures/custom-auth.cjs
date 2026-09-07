/**
 * A host's own CAP auth impl, as a consumer might ship it: a factory taking the
 * auth options and returning an express middleware that rejects every request
 * without an `x-host-key` header. Used by agent-token-auth.test.ts to prove the
 * agent-token lane delegates to THIS gate instead of replacing it.
 */
module.exports = function customAuth(options) {
  const expected = (options && options.hostKey) || 'let-me-in';
  return function customAuthMiddleware(req, res, next) {
    if (req.headers['x-host-key'] !== expected) {
      res.statusCode = 401;
      res.end('custom gate: no');
      return;
    }
    req.user = { id: 'host-user', roles: [], is: () => false };
    next();
  };
};
