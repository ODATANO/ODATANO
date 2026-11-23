#!/usr/bin/env node
// Applies the schema changes the additive schema deploy refuses: a changed key, a changed column
// type, a dropped column, a renamed table. Every step runs only where it is still due.
// Run with ODATANO stopped, before the schema deploy. --dry-run only reports.
import cds from '@sap/cds';

const T = (name) => `odatano_cardano_${name}`;
const E = (name) => `odatano.cardano.${name}`;
const TX_SEQ_SLOT_FACTOR = 65536;
/** Column type the schema deploy creates for a timestamp, per database. */
const TIMESTAMP = { postgres: 'TIMESTAMP', sqlite: 'TIMESTAMP_TEXT' };

/** Column names of a table with their declared types, both lower-cased. Empty when the table is missing. */
export async function columnsOf(db, table) {
    const rows = db.kind === 'postgres'
        ? await db.run(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table.toLowerCase()}'`)
        : await db.run(`SELECT name, type FROM pragma_table_info('${table}')`);
    return new Map(rows.map(r => [String(r.name).toLowerCase(), String(r.type).toLowerCase()]));
}

/** 'table', 'view' or null for a name in the current schema. */
export async function relationKind(db, name) {
    const rows = db.kind === 'postgres'
        ? await db.run(`SELECT CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'v') AND c.relname = '${name.toLowerCase()}'`)
        : await db.run(`SELECT type AS kind FROM sqlite_schema WHERE type IN ('table', 'view') AND lower(name) = '${name.toLowerCase()}'`);
    return rows[0]?.kind ?? null;
}

/** True for a declared type that holds a time as plain text. */
export function isTextType(type) {
    return /char|text|string/.test(type) && !type.includes('timestamp');
}

/** Counts the blocks whose time is not a UTC timestamp in ISO 8601 form. */
export function unparsableSql(kind) {
    const pattern = kind === 'postgres'
        ? `time !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'`
        : `time NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'`;
    return `SELECT count(*) AS n FROM ${T('Blocks')} WHERE time IS NOT NULL AND ${pattern}`;
}

/** CREATE TABLE statement of a SQLite table under a new name, with `time` declared as a timestamp. */
export function rebuiltTableSql(createSql, table, newName) {
    const retyped = createSql.replace(/(\btime\s+)N?VARCHAR\s*\(\s*\d+\s*\)/i, `$1${TIMESTAMP.sqlite}`);
    if (retyped === createSql) throw new Error(`${table}: no text column time in its table definition`);
    return retyped.replace(new RegExp(`^(\\s*CREATE TABLE\\s+)"?${table}"?`, 'i'), `$1${newName}`);
}

// What a SAP HANA user does instead: an HDI container takes no DDL from the runtime user.
export const HANA_UPGRADE = 'SAP HANA: this script cannot migrate an HDI container. Deploy this version into a new HDI container '
    + 'and point the application at it. The chain data is read again on demand; the records of your own transactions stay in the '
    + 'old container. docs/guides/UPGRADE_2.0.md has the steps.';

// Tables that moved from the transaction hash to Transactions.txSeq as their key.
// `to` is the entity that holds the rows in the model of this version.
const TX_SEQ_TABLES = [
    { from: 'TransactionInputs', to: 'TransactionInputs', hashKey: 'tx_hash', seqKey: 'txSeq', order: 'inputIndex' },
    { from: 'TransactionOutputs', to: 'TransactionOutputs', hashKey: 'tx_hash', seqKey: 'txSeq', order: 'outputIndex' },
    { from: 'TransactionInputAssets', to: 'TransactionInputAssetCopies', hashKey: 'input_tx_hash', seqKey: 'input_txSeq', order: 'input_inputIndex, unit' },
    { from: 'TransactionOutputAssets', to: 'TransactionOutputAssets', hashKey: 'output_tx_hash', seqKey: 'output_txSeq', order: 'output_outputIndex, unit' },
];

/** Copy statement: the given columns of the old table, the new key from Transactions. */
export function copySql(spec, columns, target) {
    const others = columns.filter(c => c !== spec.hashKey.toLowerCase());
    const into = [spec.seqKey, ...others].join(', ');
    const source = ['t.txSeq', ...others.map(c => `x.${c}`)].join(', ');
    const order = ['t.txSeq', ...spec.order.split(',').map(c => `x.${c.trim()}`)].join(', ');
    return `INSERT INTO ${target} (${into}) SELECT ${source} FROM ${T(spec.from)} x `
        + `JOIN ${T('Transactions')} t ON t.hash = x.${spec.hashKey} ORDER BY ${order}`;
}

async function count(tx, table) {
    const [row] = await tx.run(`SELECT count(*) AS n FROM ${table}`);
    return Number(row.n);
}

/** Name of the unique constraint that holds one idempotency key per job. */
const WALLET_JOBS_DEDUP = 'odatano_cardano_CardanoWalletJobs_dedup';

/** An allow list as stored: a JSON array of names, anything else is empty. */
function grantList(raw) {
    try {
        const list = JSON.parse(String(raw ?? '[]'));
        return Array.isArray(list) ? list.filter(n => typeof n === 'string') : [];
    } catch {
        return [];
    }
}

/** The grantable operations of a model, `Service.operation`, by their name without the service. */
export function grantableByName(model) {
    const definitions = Object.entries(model?.definitions ?? {});
    const services = definitions.filter(([, def]) => def.kind === 'service').map(([name]) => name);
    const byName = new Map();
    const add = (service, operation, def) => {
        if (def?.['@odatano.agent'] !== 'grant') return;
        byName.set(operation, [...(byName.get(operation) ?? []), `${service}.${operation}`]);
    };
    for (const [name, def] of definitions) {
        const service = services.find(s => name.startsWith(`${s}.`));
        if (!service) continue;
        if (def.kind === 'action' || def.kind === 'function') add(service, name.slice(service.length + 1), def);
        for (const [bound, action] of Object.entries(def.actions ?? {})) add(service, bound, action);
    }
    return byName;
}

// A stored allow list with every name qualified. A name without a service allowed the operation of
// that name in every service, so it becomes all of them; a name nothing declares any more is dropped.
export function qualifiedGrantList(list, byName) {
    const grantable = new Set([...byName.values()].flat());
    const out = list.flatMap(name => (name.includes('.') ? (grantable.has(name) ? [name] : []) : (byName.get(name) ?? [])));
    return [...new Set(out)];
}

/** Lower-cased columns of a unique constraint, in order; null when the table or the constraint is missing. */
// Where one idempotency key is held by several jobs, every job but one releases it: a job still in
// flight keeps it, else the newest. createdAt, then ID, break a tie the same way on every database.
export function releaseSharedClaimsSql(table) {
    const flight = (alias) => `CASE WHEN ${alias}.status IN ('submitting', 'submitted') THEN 1 ELSE 0 END`;
    return `UPDATE ${table} SET dedupKey = ID WHERE dedupKey <> ID AND EXISTS (`
        + `SELECT 1 FROM ${table} o WHERE o.dedupKey = ${table}.dedupKey AND o.ID <> ${table}.ID AND (`
        + `${flight('o')} > ${flight(table)} OR (${flight('o')} = ${flight(table)} AND (`
        + `o.createdAt > ${table}.createdAt OR (o.createdAt = ${table}.createdAt AND o.ID > ${table}.ID)))))`;
}

export async function uniqueColumns(db, table, constraint) {
    if (db.kind === 'postgres') {
        const rows = await db.run(`SELECT a.attname AS name FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
            JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, pos) ON true
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
            WHERE n.nspname = current_schema() AND c.conname = '${constraint.toLowerCase()}' ORDER BY k.pos`);
        return rows.length ? rows.map(r => String(r.name).toLowerCase()) : null;
    }
    const [stored] = await db.run(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '${table}'`);
    const match = String(stored?.sql ?? '').match(new RegExp(`CONSTRAINT\\s+"?${constraint}"?\\s+UNIQUE\\s*\\(([^)]*)\\)`, 'i'));
    return match ? match[1].split(',').map(c => c.trim().replace(/"/g, '').toLowerCase()) : null;
}

// The steps, oldest first. `due` says whether the database still needs the step (`pending` names the
// earlier steps that are due), `apply` changes the database, `model` makes the stored model say the same.
export const STEPS = [
    {
        name: 'transaction inputs and outputs keyed by txSeq',
        async due(db) {
            if (!(await columnsOf(db, T('TransactionInputs'))).has('tx_hash')) return false;
            const open = Number((await db.run(`SELECT count(*) AS n FROM ${T('Transactions')} WHERE slot IS NULL OR txIndex IS NULL`))[0].n);
            if (open > 0) throw new Error(`${open} transactions have no slot or txIndex; their txSeq cannot be derived`);
            return true;
        },
        async apply(tx, { ddl, log }) {
            if (!(await columnsOf(tx, T('Transactions'))).has('txseq')) await tx.run(`ALTER TABLE ${T('Transactions')} ADD COLUMN txSeq BIGINT`);
            await tx.run(`UPDATE ${T('Transactions')} SET txSeq = slot * ${TX_SEQ_SLOT_FACTOR} + txIndex`);
            await tx.run(`CREATE INDEX IF NOT EXISTS odatano_cardano_transactions_txseq ON ${T('Transactions')} (txSeq)`);

            for (const spec of TX_SEQ_TABLES) {
                const from = T(spec.from);
                const to = T(spec.to);
                const rebuilt = `${to}_txseq_new`;
                const rows = await count(tx, from);
                await tx.run(ddl(spec.to).replace(new RegExp(`^(\\s*CREATE TABLE )${to}\\b`, 'i'), `$1${rebuilt}`));
                // only columns both layouts have: a column this version dropped stays behind
                const kept = new Set((await columnsOf(tx, rebuilt)).keys());
                const columns = [...(await columnsOf(tx, from)).keys()].filter(c => c === spec.hashKey.toLowerCase() || kept.has(c));
                await tx.run(copySql(spec, columns, rebuilt));
                const copied = await count(tx, rebuilt);
                if (copied !== rows) throw new Error(`${from}: ${rows} rows, ${copied} copied (rows without a Transactions row?)`);
                await tx.run(`DROP TABLE ${from}`);
                await tx.run(`ALTER TABLE ${rebuilt} RENAME TO ${to}`);
                if (tx.kind === 'postgres') {
                    await tx.run(`ALTER TABLE ${to} RENAME CONSTRAINT ${rebuilt.toLowerCase()}_pkey TO ${to.toLowerCase()}_pkey`);
                }
                log(`${to}: ${copied} rows`);
            }
            // fresh planner statistics: without them the rebuilt tables are read by sequential scans
            for (const name of ['Transactions', ...TX_SEQ_TABLES.map(t => t.to)]) await tx.run(`ANALYZE ${T(name)}`);
        },
        model(definitions, image) {
            delete definitions[E('TransactionInputAssets')];
            for (const spec of TX_SEQ_TABLES) definitions[E(spec.to)] = image[E(spec.to)];
            const transactions = definitions[E('Transactions')];
            const current = image[E('Transactions')].elements;
            if (!transactions?.elements) return;
            transactions.elements.txSeq = current.txSeq;
            // the compositions into the rebuilt tables join on txSeq now; a stale join makes the
            // deploy emit an empty statement for them
            const rebuilt = new Set(TX_SEQ_TABLES.map(t => E(t.to)));
            for (const [name, element] of Object.entries(current)) {
                if (element.target && rebuilt.has(element.target)) transactions.elements[name] = element;
            }
        },
    },
    {
        name: 'Blocks.time: text -> timestamp',
        async due(db) {
            const type = (await columnsOf(db, T('Blocks'))).get('time');
            if (type === undefined || !isTextType(type)) return false;
            const unparsable = Number((await db.run(unparsableSql(db.kind)))[0].n);
            if (unparsable > 0) throw new Error(`${unparsable} blocks hold a time that is no ISO 8601 UTC timestamp`);
            return `${await count(db, T('Blocks'))} rows`;
        },
        async apply(tx) {
            const table = T('Blocks');
            if (tx.kind === 'postgres') {
                await tx.run(`ALTER TABLE ${table} ALTER COLUMN time TYPE ${TIMESTAMP.postgres} USING (time::timestamptz AT TIME ZONE 'UTC')`);
                return;
            }
            // SQLite cannot change a column's type: the table is rebuilt with the same rows
            const rebuilt = `${table}_time_new`;
            const rows = await count(tx, table);
            const [stored] = await tx.run(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '${table}'`);
            await tx.run(rebuiltTableSql(stored.sql, table, rebuilt));
            await tx.run(`INSERT INTO ${rebuilt} SELECT * FROM ${table}`);
            const copied = await count(tx, rebuilt);
            if (copied !== rows) throw new Error(`${table}: ${rows} rows, ${copied} copied`);
            await tx.run(`DROP TABLE ${table}`);
            await tx.run(`ALTER TABLE ${rebuilt} RENAME TO ${table}`);
        },
        model(definitions, image) {
            const stored = definitions[E('Blocks')];
            if (stored?.elements?.time) stored.elements.time = image[E('Blocks')].elements.time;
        },
    },
    {
        name: 'CardanoAgentGrants: columns walletId and allowedJobKinds removed',
        async due(db) {
            const columns = await columnsOf(db, T('CardanoAgentGrants'));
            return columns.has('walletid') || columns.has('allowedjobkinds');
        },
        async apply(tx) {
            const columns = await columnsOf(tx, T('CardanoAgentGrants'));
            for (const column of ['walletId', 'allowedJobKinds']) {
                if (columns.has(column.toLowerCase())) await tx.run(`ALTER TABLE ${T('CardanoAgentGrants')} DROP COLUMN ${column}`);
            }
        },
        model(definitions) {
            const elements = definitions[E('CardanoAgentGrants')]?.elements ?? {};
            delete elements.walletId;
            delete elements.allowedJobKinds;
        },
    },
    {
        name: 'TransactionInputAssets: table renamed to TransactionInputAssetCopies',
        async due(db, pending) {
            // the txSeq step builds the table under its new name already
            if (pending.includes(STEPS[0].name)) return false;
            if (await relationKind(db, T('TransactionInputAssets')) !== 'table') return false;
            if (await relationKind(db, T('TransactionInputAssetCopies'))) {
                throw new Error(`${T('TransactionInputAssets')} and ${T('TransactionInputAssetCopies')} both exist as tables`);
            }
            return true;
        },
        async apply(tx) {
            const from = T('TransactionInputAssets');
            const to = T('TransactionInputAssetCopies');
            await tx.run(`ALTER TABLE ${from} RENAME TO ${to}`);
            if (tx.kind !== 'postgres') return;
            const [key] = await tx.run(`SELECT 1 AS x FROM pg_constraint WHERE conname = '${from.toLowerCase()}_pkey' AND connamespace = current_schema()::regnamespace`);
            if (key) await tx.run(`ALTER TABLE ${to} RENAME CONSTRAINT ${from.toLowerCase()}_pkey TO ${to.toLowerCase()}_pkey`);
        },
        model(definitions, image) {
            delete definitions[E('TransactionInputAssets')];
            definitions[E('TransactionInputAssetCopies')] = image[E('TransactionInputAssetCopies')];
            // the deploy adds the association to the view again; it has no column
            delete definitions[E('TransactionInputs')]?.elements?.assets;
        },
    },
    {
        name: 'CardanoWalletJobs: one idempotency key per user across wallets and kinds',
        async due(db) {
            const columns = await uniqueColumns(db, T('CardanoWalletJobs'), WALLET_JOBS_DEDUP);
            return columns !== null && columns.join(',') !== 'dedupkey';
        },
        async apply(tx) {
            const table = T('CardanoWalletJobs');
            await tx.run(releaseSharedClaimsSql(table));
            if (tx.kind === 'postgres') {
                await tx.run(`ALTER TABLE ${table} DROP CONSTRAINT ${WALLET_JOBS_DEDUP}`);
                await tx.run(`ALTER TABLE ${table} ADD CONSTRAINT ${WALLET_JOBS_DEDUP} UNIQUE (dedupKey)`);
                return;
            }
            // SQLite cannot change a table constraint: the table is rebuilt with the same rows
            const rebuilt = `${table}_dedup_new`;
            const rows = await count(tx, table);
            const [stored] = await tx.run(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '${table}'`);
            const createSql = String(stored.sql).replace(/(CONSTRAINT\s+"?\w+_dedup"?\s+UNIQUE\s*)\([^)]*\)/i, '$1(dedupKey)');
            if (createSql === stored.sql) throw new Error(`${table}: no constraint ${WALLET_JOBS_DEDUP} in its table definition`);
            await tx.run(createSql.replace(new RegExp(`^(\\s*CREATE TABLE\\s+)"?${table}"?`, 'i'), `$1${rebuilt}`));
            await tx.run(`INSERT INTO ${rebuilt} SELECT * FROM ${table}`);
            const copied = await count(tx, rebuilt);
            if (copied !== rows) throw new Error(`${table}: ${rows} rows, ${copied} copied`);
            await tx.run(`DROP TABLE ${table}`);
            await tx.run(`ALTER TABLE ${rebuilt} RENAME TO ${table}`);
        },
        model(definitions, image) {
            const stored = definitions[E('CardanoWalletJobs')];
            if (stored) stored['@assert.unique.dedup'] = image[E('CardanoWalletJobs')]['@assert.unique.dedup'];
        },
    },
    {
        name: 'CardanoAgentGrants: allow lists name Service.operation',
        async due(db) {
            if (!(await columnsOf(db, T('CardanoAgentGrants'))).has('allowedactions')) return false;
            const rows = await db.run(`SELECT allowedActions AS actions FROM ${T('CardanoAgentGrants')}`);
            const open = rows.filter(r => grantList(r.actions).some(name => !name.includes('.'))).length;
            return open ? `${open} grants` : false;
        },
        async apply(tx, { model }) {
            const byName = grantableByName(model);
            const table = T('CardanoAgentGrants');
            const update = tx.kind === 'postgres'
                ? `UPDATE ${table} SET allowedActions = $1 WHERE ID = $2`
                : `UPDATE ${table} SET allowedActions = ? WHERE ID = ?`;
            for (const row of await tx.run(`SELECT ID AS id, allowedActions AS actions FROM ${table}`)) {
                const list = grantList(row.actions);
                if (!list.some(name => !name.includes('.'))) continue;
                await tx.run(update, [JSON.stringify(qualifiedGrantList(list, byName)), row.id]);
            }
        },
        model() {},
    },
];

/** Names of all views of the schema, the ones created last first. */
async function viewNames(db) {
    const rows = db.kind === 'postgres'
        ? await db.run(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'v' AND n.nspname = current_schema() ORDER BY c.oid DESC`)
        : await db.run(`SELECT name FROM sqlite_schema WHERE type = 'view' ORDER BY rowid DESC`);
    return rows.map(r => r.name);
}

/** Database names of the views the models define, lower-cased. */
export function modelViewNames(...models) {
    const names = new Set();
    for (const model of models) {
        for (const [name, def] of Object.entries(model?.definitions ?? {})) {
            if (def.kind === 'entity' && isView(def)) names.add(name.replace(/\./g, '_').toLowerCase());
        }
    }
    return names;
}

async function hasModelTable(db) {
    const [found] = await db.run(db.kind === 'postgres'
        ? `SELECT 1 AS x FROM pg_tables WHERE tablename = 'cds_model' AND schemaname = current_schema()`
        : `SELECT 1 AS x FROM sqlite_schema WHERE name = 'cds_model'`);
    return Boolean(found);
}

/** The model of this version as the schema deploy stores it, and the CREATE TABLE statement of an entity. */
async function modelOfThisVersion(db) {
    const model = await cds.load('*').then(cds.minify);
    cds.deploy.exclude_external_entities_in(model);
    const options = { ...db.options };
    const statements = cds.compile.to.sql(model, options);
    const ddl = (name) => {
        const found = statements.find(s => new RegExp(`^CREATE TABLE ${T(name)} \\(`, 'i').test(s.trim()));
        if (!found) throw new Error(`the model has no table ${T(name)}`);
        return found;
    };
    return { model, options, image: cds.compile.to.sql.delta(model, options).afterImage, ddl };
}

const isView = (def) => Boolean(def.query || def.projection);

/** PostgreSQL columns of a table with length, precision and scale, by lower-cased name. */
async function columnSizes(db, table) {
    const rows = await db.run(`SELECT column_name AS name, character_maximum_length AS length, numeric_precision AS precision, numeric_scale AS scale
        FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table.toLowerCase()}'`);
    return new Map(rows.map(r => [String(r.name).toLowerCase(), r]));
}

/** `element` with the length, precision and scale its PostgreSQL column has. */
export function sizedAsStored(element, column) {
    if (!column) return element;
    const sized = { ...element };
    if (element.type === 'cds.Decimal' && column.precision != null) {
        sized.precision = Number(column.precision);
        sized.scale = Number(column.scale ?? 0);
    }
    if (element.type === 'cds.String' && column.length != null) sized.length = Number(column.length);
    return sized;
}

// The model of this version cut down to what the database holds: its tables and their columns,
// no views. On PostgreSQL the sizes are the stored ones, so the deploy widens what this version widened.
export async function modelOfDatabase(db, image) {
    const definitions = {};
    for (const [name, def] of Object.entries(image.definitions)) {
        if (def.kind !== 'entity') { definitions[name] = def; continue; }
        if (isView(def)) continue;
        const table = name.replace(/\./g, '_');
        const columns = await columnsOf(db, table);
        if (!columns.size) continue;
        const sizes = db.kind === 'postgres' ? await columnSizes(db, table) : new Map();
        const elements = {};
        for (const [elementName, element] of Object.entries(def.elements ?? {})) {
            const column = element['@cds.persistence.name'];
            if (column !== undefined && !columns.has(String(column).toLowerCase())) continue;
            elements[elementName] = column === undefined ? element : sizedAsStored(element, sizes.get(String(column).toLowerCase()));
        }
        definitions[name] = { ...def, elements };
    }
    return { ...image, definitions };
}

/** Waits for the first connection, which can take longer than the pool waits for one. */
async function connected(db) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await db.run('SELECT 1 AS x');
        } catch (err) {
            if (attempt === 15) throw err;
            await new Promise(resolve => setTimeout(resolve, Math.min(500 * attempt, 5000)));
        }
    }
}

// Statements of the deploy from `prior` to this version that render as nothing. @cap-js/postgres
// names a statement by the hash of its text, so two empty ones collide and the deploy fails.
// SQLite runs an empty statement as a no-op, so only PostgreSQL counts.
export function emptyDeltaStatements(model, options, prior) {
    if (options.kind !== 'postgres') return 0;
    const { drops, createsAndAlters } = cds.compile.to.sql.delta(model, options, prior);
    return [...drops, ...createsAndAlters].filter(sql => !String(sql).trim()).length;
}

/** Refuses a stored model the deploy cannot take, before the deploy changes anything. */
export async function assertDeployable(db) {
    if (db.kind !== 'postgres') return;
    if (!(await hasModelTable(db))) return;
    const prior = JSON.parse((await db.run('SELECT csn FROM cds_model'))[0].csn);
    const { model, options } = await modelOfThisVersion(db);
    const empty = emptyDeltaStatements(model, options, prior);
    if (empty) {
        throw new Error(`the deploy from the stored model (cds_model) would run ${empty} empty statements, which the database refuses. `
            + 'The stored model holds a change the migration steps do not cover. Nothing was changed.');
    }
}

/** The steps the database still needs, with what `due` reported for each. */
async function dueSteps(db) {
    const due = [];
    for (const step of STEPS) {
        const detail = await step.due(db, due.map(d => d.step.name));
        if (detail) due.push({ step, detail });
    }
    return due;
}

// Brings an existing database to the point where the additive schema deploy can take over, and
// returns the names of the steps it ran. A database without a stored model gets one here.
// Whenever it changes something the views are gone afterwards; the deploy creates them.
export async function migrateSchema(db, { dryRun = false, log = console.log } = {}) {
    if (db.kind === 'hana') throw new Error(HANA_UPGRADE);
    if (db.kind !== 'postgres' && db.kind !== 'sqlite') throw new Error(`unsupported database kind ${db.kind}: PostgreSQL and SQLite are migrated`);
    await connected(db);

    const due = await dueSteps(db);
    const stored = await hasModelTable(db);
    // a database that holds none of our tables is new: the deploy creates it
    const adopt = !stored && (await columnsOf(db, T('Blocks'))).size > 0;
    if (!due.length && !adopt) return [];

    const [lease] = await db.run(`SELECT leaseUntil FROM ${T('CardanoSyncState')}`).catch(() => []);
    const leaseUntil = lease?.leaseUntil ?? lease?.leaseuntil;
    if (leaseUntil && Date.parse(leaseUntil) > Date.now()) {
        throw new Error(`the crawler lease is held until ${leaseUntil}: stop ODATANO first`);
    }

    for (const { step, detail } of due) log(`due: ${step.name}${detail === true ? '' : ` (${detail})`}`);
    if (adopt) log('due: the database has no stored model (cds_model), it is written from its tables');
    const names = due.map(d => d.step.name);
    if (dryRun) { log('dry run: nothing changed'); return names; }

    const { model: current, options, image, ddl } = await modelOfThisVersion(db);
    await db.tx(async (tx) => {
        const started = Date.now();
        const done = (msg) => log(`[${Math.round((Date.now() - started) / 1000)}s] ${msg}`);

        const model = stored ? JSON.parse((await tx.run('SELECT csn FROM cds_model'))[0].csn) : null;
        // only views of the models: any other view stays, and one that depends on ours makes the drop fail
        const ours = modelViewNames(model, image);
        const views = (await viewNames(tx)).filter(name => ours.has(String(name).toLowerCase()));
        for (const name of views) await tx.run(`DROP VIEW IF EXISTS "${name}"`);
        done(`${views.length} views dropped`);

        for (const { step } of due) {
            await step.apply(tx, { ddl, log: done, model: current });
            if (model) step.model(model.definitions, image.definitions);
            done(step.name);
        }

        if (model) {
            // the stored model lists no view any more, so the deploy creates every view of this version
            for (const [name, def] of Object.entries(model.definitions)) {
                if (isView(def)) delete model.definitions[name];
            }
            const empty = emptyDeltaStatements(current, options, model);
            if (empty) throw new Error(`after the steps the deploy would run ${empty} empty statements; nothing was changed`);
            await tx.run(db.kind === 'postgres' ? 'UPDATE cds_model SET csn = $1' : 'UPDATE cds_model SET csn = ?', [JSON.stringify(model)]);
        } else {
            const adopted = await modelOfDatabase(tx, image);
            const empty = emptyDeltaStatements(current, options, adopted);
            if (empty) throw new Error(`for the stored model written from the tables the deploy would run ${empty} empty statements; nothing was changed`);
            const csn = JSON.stringify(adopted);
            await tx.run(`CREATE TABLE cds_model (csn ${db.kind === 'postgres' ? 'TEXT' : 'CLOB'})`);
            await tx.run(db.kind === 'postgres' ? 'INSERT INTO cds_model VALUES ($1)' : 'INSERT INTO cds_model VALUES (?)', [csn]);
        }
        done(`cds_model ${model ? 'updated' : 'written'}`);
    });
    return adopt ? [...names, 'stored model written'] : names;
}

async function main() {
    const db = await cds.connect.to('db');
    const dryRun = process.argv.includes('--dry-run');
    const ran = await migrateSchema(db, { dryRun });
    if (!ran.length) console.log('The schema needs no migration.');
    else if (!dryRun) console.log('Migrated. Deploy the schema now; it creates the views again.');
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
    main().then(() => process.exit(0), (err) => { console.error(`FAILED: ${err.message}`); process.exit(1); });
}
