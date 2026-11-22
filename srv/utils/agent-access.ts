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
}

const tables = new WeakMap<object, AccessTable>();

function buildTable(model: Model): AccessTable {
  const table: AccessTable = { closed: new Set(), operations: new Map() };
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
  return table;
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

/** Names of the operations a grant may list, in model order. */
export function agentGrantableActions(model: Model | null | undefined = cds.model): string[] {
  const table = tableOf(model);
  if (!table) return [];
  const names = [...table.operations].filter(([, access]) => access === 'grant').map(([key]) => key.slice(key.indexOf('.') + 1));
  return [...new Set(names)];
}
