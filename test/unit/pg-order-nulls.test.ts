/**
 * ORDER BY on PostgreSQL (srv/utils/pg-order-nulls.ts): rendered through the
 * real @cap-js/postgres renderer against a tiny model, so a driver that changes
 * its ordering terms fails here instead of silently sorting the table again.
 */
import cds from '@sap/cds';
import { installPostgresOrderNulls, stripNullsForNotNull } from '../../srv/utils/pg-order-nulls';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PostgresService = require('@cap-js/postgres/lib/PostgresService');

function renderer() {
  const csn = cds.compile.to.csn(`namespace t; aspect temporal { validFrom: Timestamp @cds.valid.from; validTo: Timestamp @cds.valid.to; } entity Blocks { key ID: UUID; height: Integer64 not null; note: String; } entity Assets : temporal { key unit: String; }`);
  cds.model = cds.linked(csn);
  const srv = new PostgresService('db', cds.model, { kind: 'postgres', credentials: {} });
  return (q: unknown) => String(srv.cqn2sql(q).sql).replace(/^.*FROM/, 'FROM');
}

describe('stripNullsForNotNull', () => {
  it('drops the clause for key and NOT NULL columns, keeps it for nullable ones and for an explicit nulls', () => {
    const terms = [{ element: { key: true } }, { element: { notNull: true } }, { element: {} }, { nulls: 'first', element: { key: true } }, { element: { '@cds.valid.from': true } }];
    const rendered = ['"$b".ID ASC NULLS FIRST', '"$b".height DESC NULLS LAST', '"$b".note ASC NULLS FIRST', '"$b".ID ASC NULLS FIRST', '"$b".validFrom ASC NULLS FIRST'];
    expect(stripNullsForNotNull(terms, rendered)).toEqual(['"$b".ID ASC', '"$b".height DESC', '"$b".note ASC NULLS FIRST', '"$b".ID ASC NULLS FIRST', '"$b".validFrom ASC']);
  });
});

describe('installPostgresOrderNulls', () => {
  it('renders ORDER BY on the key and on a NOT NULL column without NULLS, a nullable column with it; installs once', () => {
    const { SELECT } = cds.ql;
    expect(installPostgresOrderNulls()).toBe(true);
    expect(installPostgresOrderNulls()).toBe(true); // idempotent: the second call finds the marker
    const render = renderer();
    expect(render(SELECT.from('t.Blocks').orderBy('ID').limit(1))).toBe('FROM t_Blocks as "$b" ORDER BY "$b".ID ASC LIMIT $1');
    expect(render(SELECT.from('t.Blocks').orderBy('height desc').limit(1))).toBe('FROM t_Blocks as "$b" ORDER BY "$b".height DESC LIMIT $1');
    expect(render(SELECT.from('t.Blocks').orderBy('note').limit(1))).toBe('FROM t_Blocks as "$b" ORDER BY "$b".note ASC NULLS FIRST LIMIT $1');
    // temporal: validFrom is neither `key` nor `notNull` in the linked model, only @cds.valid.from
    expect(render(SELECT.from('t.Assets').orderBy('validFrom', 'unit').limit(1))).toBe('FROM t_Assets as "$a" ORDER BY "$a".validFrom ASC,"$a".unit ASC LIMIT $1');
  });
});
