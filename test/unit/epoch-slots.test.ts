import { describe, expect, it } from 'vitest';
import { epochOfSlot, epochStartSlot, posixToSlot, slotToPosixMs, slotToPosixSeconds } from '../../srv/utils/epoch-slots';

describe('slotToPosixSeconds', () => {
  it('anchors each network on its first Shelley slot', () => {
    expect(slotToPosixSeconds('mainnet', 4_492_800)).toBe(Date.parse('2020-07-29T21:44:51Z') / 1000);
    expect(slotToPosixSeconds('preprod', 0)).toBe(Date.parse('2022-06-20T00:00:00Z') / 1000);
    expect(slotToPosixSeconds('preview', 0)).toBe(Date.parse('2022-10-25T00:00:00Z') / 1000);
  });

  it('matches public explorers for known blocks', () => {
    // mainnet 13991089 (epoch 657), preprod 5221099 (epoch 315)
    expect(slotToPosixSeconds('mainnet', 198_869_828)).toBe(1_790_436_119);
    expect(slotToPosixSeconds('preprod', 134_720_933)).toBe(Date.parse('2026-09-26T06:28:53Z') / 1000);
  });
});

describe('posixToSlot / slotToPosixMs', () => {
  it.each(['mainnet', 'preprod', 'preview'] as const)('round-trips on %s', (network) => {
    for (const slot of [epochStartSlot(network, 300), 134_720_933, 198_869_828]) {
      expect(posixToSlot(network, slotToPosixMs(network, slot))).toBe(slot);
    }
  });

  it('maps a time inside a slot to that slot', () => {
    const ms = slotToPosixMs('preview', 1_000) + 999;
    expect(posixToSlot('preview', ms)).toBe(1_000);
  });

  it('refuses times before the Shelley start and non-numbers', () => {
    expect(() => posixToSlot('mainnet', Date.parse('2019-06-01T00:00:00Z'))).toThrow(RangeError);
    expect(() => posixToSlot('preprod', Date.parse('2022-06-20T12:00:00Z'))).toThrow(RangeError);
    expect(() => posixToSlot('preview', Number.NaN)).toThrow(RangeError);
    expect(posixToSlot('mainnet', Date.parse('2020-07-29T21:44:51Z'))).toBe(4_492_800);
  });

  it('matches public explorers for a known block', () => {
    expect(posixToSlot('mainnet', 1_790_436_119_000)).toBe(198_869_828);
    expect(posixToSlot('preprod', Date.parse('2026-09-26T06:28:53Z'))).toBe(134_720_933);
  });
});

describe('epoch helpers', () => {
  it('round-trip epoch and start slot', () => {
    expect(epochOfSlot('mainnet', 198_869_828)).toBe(657);
    expect(epochOfSlot('mainnet', epochStartSlot('mainnet', 657))).toBe(657);
    expect(epochOfSlot('preprod', 134_720_933)).toBe(315);
  });
});
