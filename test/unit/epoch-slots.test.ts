import { describe, expect, it } from 'vitest';
import { epochOfSlot, epochStartSlot, slotToPosixSeconds } from '../../srv/utils/epoch-slots';

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

describe('epoch helpers', () => {
  it('round-trip epoch and start slot', () => {
    expect(epochOfSlot('mainnet', 198_869_828)).toBe(657);
    expect(epochOfSlot('mainnet', epochStartSlot('mainnet', 657))).toBe(657);
    expect(epochOfSlot('preprod', 134_720_933)).toBe(315);
  });
});
