const { mapProviderError } = require('../../srv/utils/errors');

describe('mapProviderError', () => {
  test('maps NOT_FOUND token to 404', () => {
    const r = mapProviderError(new Error('NOT_FOUND'));
    expect(r.status).toBe(404);
    expect(r.message.toLowerCase()).toMatch(/not found/);
  });

  test('maps axios-style response status', () => {
    const err = { response: { status: 401, data: { message: 'bad key' } } };
    const r = mapProviderError(err);
    expect(r.status).toBe(401);
    // message may be the provider message or normalized text
    expect(r.message.toLowerCase()).toMatch(/bad key|provider returned http 401|unauthor/i);
  });

  test('maps timeout to 503', () => {
    const err = new Error('Primary getTransaction timed out after 8000ms');
    const r = mapProviderError(err);
    expect(r.status).toBe(503);
  });
});
