/**
 * uint64 metadata labels must fit the int64 `TransactionMetadata.id` key exactly
 * (PostgreSQL bigint range).
 */
vi.mock('@sap/cds', () => {
  const cdsMock = {
    log: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    utils: { uuid: () => 'uuid' },
  };
  return { default: cdsMock, ...cdsMock };
});

import { mapTransactionMetadata, metadataIdFor } from '../../srv/utils/mappers';

describe('metadataIdFor', () => {
  it('keeps small labels as numbers', () => {
    expect(metadataIdFor('721')).toBe(721);
    expect(metadataIdFor(1447)).toBe(1447);
    expect(metadataIdFor('0')).toBe(0);
  });

  it('passes labels above 2^53 as exact decimal strings', () => {
    expect(metadataIdFor('945845007538436815')).toBe('945845007538436815');
    expect(metadataIdFor('7505166164059511819')).toBe('7505166164059511819');
  });

  it('wraps labels >= 2^63 into the int64 range (two\'s complement), exactly', () => {
    // preprod tx ee4f7c88…, block 4441873: a label above 2^63
    expect(metadataIdFor('17802948329108123211')).toBe('-643795744601428405');
    expect(metadataIdFor('18446744073709551615')).toBe(-1); // uint64 max
    expect(metadataIdFor('9223372036854775808')).toBe('-9223372036854775808'); // 2^63
    expect(metadataIdFor('9223372036854775807')).toBe('9223372036854775807'); // int64 max
  });

  it('returns null for input that is not a non-negative integer', () => {
    expect(metadataIdFor('abc')).toBeNull();
    expect(metadataIdFor('')).toBeNull();
    expect(metadataIdFor('1.5')).toBeNull();
    expect(metadataIdFor('-1')).toBeNull();
    expect(metadataIdFor(Number.NaN)).toBeNull();
  });
});

describe('mapTransactionMetadata with an oversized label', () => {
  it('produces an in-range id and keeps the label string exact', () => {
    const rows = mapTransactionMetadata([
      { txHash: 'tx'.padEnd(64, '0'), label: '17802948329108123211', json: { a: 1 } } as never,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('-643795744601428405');
    expect(rows[0].label).toBe('17802948329108123211');
    expect(rows[0].payload).toBe('{"a":1}');
  });

  it('skips a row whose label is not a uint64 instead of emitting a NaN key', () => {
    // A NaN key fails the whole bulk write (PostgreSQL: invalid input syntax for type
    // bigint) and would count towards the crawler's poison-block latch.
    const rows = mapTransactionMetadata([
      { txHash: 'tx'.padEnd(64, '0'), label: 'abc', json: {} } as never,
      { txHash: 'tx'.padEnd(64, '0'), label: '721', json: {} } as never,
    ]);
    expect(rows.map(r => r.id)).toEqual([721]);
  });
});
