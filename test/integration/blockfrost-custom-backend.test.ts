/**
 * BlockfrostBackend customBackend integration tests
 *
 * Self-contained: uses the real @blockfrost/blockfrost-js SDK against nock,
 * to prove that customBackend URLs are actually hit (not just stored on the
 * options object). The unit tests at test/unit/blockfrost-backend.test.ts
 * mock the SDK constructor and only assert the option is forwarded — this
 * file closes the loop end-to-end.
 */
import nock from 'nock';
import { BlockfrostBackend } from '../../srv/blockchain/backends/blockfrost-backend';
import { BackendInitError } from '../../srv/utils/errors';

const CUSTOM_BACKEND = 'http://localhost:3010/api/v0';
const NETWORK = 'preview' as const;
const TIMEOUT_MS = 5000;

const BLOCK_BODY = {
  time: 1700000000,
  height: 1000000,
  hash: 'abc123',
  slot: 50000000,
  slot_leader: 'pool1xyz',
  epoch: 100,
  epoch_slot: 1234,
  size: 4096,
  tx_count: 12,
  fees: '300000',
};

describe('BlockfrostBackend customBackend integration', () => {
  beforeEach(() => {
    nock.cleanAll();
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('routes blocksLatest through the customBackend URL on init()', async () => {
    const scope = nock(CUSTOM_BACKEND).get('/blocks/latest').reply(200, BLOCK_BODY);

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, '', CUSTOM_BACKEND);
    await expect(backend.init()).resolves.toBe(true);

    expect(scope.isDone()).toBe(true);
  });

  it("sends project_id header 'self-hosted' when no key is configured", async () => {
    let captured: Record<string, string | string[] | undefined> | undefined;
    nock(CUSTOM_BACKEND)
      .get('/blocks/latest')
      .reply(function () {
        captured = this.req.headers;
        return [200, BLOCK_BODY];
      });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, '', CUSTOM_BACKEND);
    await backend.init();

    expect(captured?.project_id).toBe('self-hosted');
  });

  it('forwards a real projectId header when both projectId and customBackend are set', async () => {
    let captured: Record<string, string | string[] | undefined> | undefined;
    nock(CUSTOM_BACKEND)
      .get('/blocks/latest')
      .reply(function () {
        captured = this.req.headers;
        return [200, BLOCK_BODY];
      });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, 'preview_xyz', CUSTOM_BACKEND);
    await backend.init();

    expect(captured?.project_id).toBe('preview_xyz');
  });

  it('throws BackendInitError when the customBackend returns a non-2xx', async () => {
    nock(CUSTOM_BACKEND).get('/blocks/latest').reply(503, { message: 'unavailable' });

    const backend = new BlockfrostBackend(NETWORK, TIMEOUT_MS, '', CUSTOM_BACKEND);
    await expect(backend.init()).rejects.toThrow(BackendInitError);
  });
});
