/**
 * CardanoAgentService refuses every operation while agent grants are off, so no grant can be
 * issued that turns into a live token once the feature is switched on.
 */

export {};

type Handler = (req: unknown) => unknown;

/** The service implementation, as CAP loads it: the module itself is the function. */
async function load(): Promise<(srv: unknown) => void> {
  const mod = await import('../../srv/cardano-agent-service') as unknown as { default?: (srv: unknown) => void } & ((srv: unknown) => void);
  return mod.default ?? mod;
}

async function mount() {
  const before: Handler[] = [];
  const srv = { before: (_event: string, fn: Handler) => { before.push(fn); }, on: () => undefined, after: () => undefined, name: 'CardanoAgentService' };
  (await load())(srv);
  return before;
}

const ENV = process.env.AGENT_GRANTS_ENABLED;
afterEach(() => { if (ENV === undefined) delete process.env.AGENT_GRANTS_ENABLED; else process.env.AGENT_GRANTS_ENABLED = ENV; });

describe('CardanoAgentService while agent grants are off', () => {
  it('refuses every operation with 400', async () => {
    delete process.env.AGENT_GRANTS_ENABLED;
    const [gate] = await mount();
    expect(() => gate({ event: 'CreateAgentGrant' })).toThrow(/Agent grants are not enabled/);
    expect(() => gate({ event: 'READ' })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('lets the operations through once they are on', async () => {
    process.env.AGENT_GRANTS_ENABLED = 'true';
    const [gate] = await mount();
    expect(gate({ event: 'CreateAgentGrant' })).toBeUndefined();
  });
});
