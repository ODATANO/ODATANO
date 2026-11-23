import cds from '@sap/cds';

// What an agent token may do with an operation, declared as `@odatano.agent` next to it in the model:
// `read` always, `grant` when its grant lists the operation, `operator` never.
export type AgentAccess = 'read' | 'grant' | 'operator';

const ANNOTATION = '@odatano.agent';
const LEVELS: readonly string[] = ['read', 'grant', 'operator'];

interface Annotated {
  kind?: string;
  [ANNOTATION]?: unknown;
  actions?: Record<string, Annotated>;
}

type Model = { definitions?: Record<string, unknown> };

interface AccessTable {
  /** Services annotated `closed`: every event of a token is refused, reads included. */
  closed: Set<string>;
  /** Access by `Service.operation`. */
  operations: Map<string, AgentAccess>;
  /** The grantable `Service.operation` names, in model order. */
  grantable: readonly string[];
}

const tables = new WeakMap<object, AccessTable>();

function buildTable(model: Model): AccessTable {
  const table: { closed: Set<string>; operations: Map<string, AgentAccess> } = { closed: new Set(), operations: new Map() };
  const definitions = Object.entries((model.definitions ?? {}) as Record<string, Annotated>);
  const services = definitions.filter(([, def]) => def.kind === 'service').map(([name]) => name);
  const serviceOf = (name: string) => services.find((service) => name.startsWith(`${service}.`));

  const add = (service: string, operation: string, def: Annotated): void => {
    const access = def[ANNOTATION];
    if (typeof access !== 'string' || !LEVELS.includes(access)) return;
    const key = `${service}.${operation}`;
    const known = table.operations.get(key);
    // two operations of one service under one name must agree, else the name is refused
    table.operations.set(key, known && known !== access ? 'operator' : (access as AgentAccess));
  };

  for (const [name, def] of definitions) {
    if (def.kind === 'service' && def[ANNOTATION] === 'closed') table.closed.add(name);
    const service = serviceOf(name);
    if (!service) continue;
    if (def.kind === 'action' || def.kind === 'function') add(service, name.slice(service.length + 1), def);
    for (const [bound, action] of Object.entries(def.actions ?? {})) add(service, bound, action);
  }
  const grantable = Object.freeze([...table.operations].filter(([, access]) => access === 'grant').map(([key]) => key));
  return { ...table, grantable };
}

function tableOf(model: Model | null | undefined): AccessTable | undefined {
  if (!model) return undefined;
  let table = tables.get(model);
  if (!table) tables.set(model, (table = buildTable(model)));
  return table;
}

// Access of an agent token to `event` on `service`. Entity reads are `read`. An operation without
// the annotation, any other event and everything before the model is loaded are `operator`.
export function agentAccessOf(service: string, event: string, model: Model | null | undefined = cds.model): AgentAccess | 'closed' {
  const table = tableOf(model);
  if (!table) return 'operator';
  if (table.closed.has(service)) return 'closed';
  if (event === 'READ') return 'read';
  return table.operations.get(`${service}.${event}`) ?? 'operator';
}

/** The operations a grant may list, as `Service.operation`, in model order. */
export function agentGrantableActions(model: Model | null | undefined = cds.model): readonly string[] {
  return tableOf(model)?.grantable ?? [];
}

/** The service whose operations a new unqualified grant name never means: it takes raw provider calls. */
const BACKEND_SERVICE = 'CardanoBackendService';

const named = (grantable: readonly string[], name: string) => grantable.filter((key) => key.endsWith(`.${name}`));

// The grantable `Service.operation` a new grant entry names, or null. A name without a service means
// the operation of that name in the transaction or the sign service.
export function qualifyGrantName(name: string, model: Model | null | undefined = cds.model): string | null {
  const grantable = agentGrantableActions(model);
  if (name.includes('.')) return grantable.includes(name) ? name : null;
  const matches = named(grantable, name).filter((key) => !key.startsWith(`${BACKEND_SERVICE}.`));
  return matches.length === 1 ? matches[0] : null;
}

// What a stored grant entry allows. A name without a service was stored before allow lists were
// qualified, and it allowed the operation of that name in every service.
export function storedGrantNames(name: string, model: Model | null | undefined = cds.model): readonly string[] {
  const grantable = agentGrantableActions(model);
  if (name.includes('.')) return grantable.includes(name) ? [name] : [];
  return named(grantable, name);
}
