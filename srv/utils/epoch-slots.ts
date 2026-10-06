import { EPOCH_CONFIG_BY_NETWORK, GENESIS_INFOS_BY_NETWORK } from './const';

type EpochNetwork = keyof typeof EPOCH_CONFIG_BY_NETWORK;

/** Epoch a slot belongs to, from the network's Shelley anchor. */
export function epochOfSlot(network: EpochNetwork, slot: number): number {
  const cfg = EPOCH_CONFIG_BY_NETWORK[network];
  return cfg.shelleyStartEpoch + Math.floor((slot - cfg.shelleyStartSlot) / cfg.slotsPerEpoch);
}

/** First absolute slot of an epoch, from the network's Shelley anchor. */
export function epochStartSlot(network: EpochNetwork, epoch: number): number {
  const cfg = EPOCH_CONFIG_BY_NETWORK[network];
  return cfg.shelleyStartSlot + (epoch - cfg.shelleyStartEpoch) * cfg.slotsPerEpoch;
}

/**
 * Absolute POSIX milliseconds for a slot via the Shelley-anchored genesis infos (exact for Shelley-era
 * slots). Ogmios' `eraStart.time` is RelativeTime since system start, not a Unix timestamp.
 */
export function slotToPosixMs(network: EpochNetwork, slot: number): number {
  const genesis = GENESIS_INFOS_BY_NETWORK[network];
  return genesis.systemStartPosixMs + (slot - genesis.startSlotNo) * genesis.slotLengthMs;
}

/** Absolute POSIX seconds for a slot, rounded down. */
export function slotToPosixSeconds(network: EpochNetwork, slot: number): number {
  return Math.floor(slotToPosixMs(network, slot) / 1000);
}

/**
 * Slot that contains a POSIX time in milliseconds.
 * @throws RangeError for a time before the Shelley start, where slots were 20 s long.
 */
export function posixToSlot(network: EpochNetwork, posixMs: number): number {
  const genesis = GENESIS_INFOS_BY_NETWORK[network];
  const shelleyStartMs = slotToPosixMs(network, EPOCH_CONFIG_BY_NETWORK[network].shelleyStartSlot);
  if (!Number.isFinite(posixMs) || posixMs < shelleyStartMs) {
    throw new RangeError(`posixToSlot: ${posixMs} is not a time from the ${network} Shelley start on`);
  }
  return genesis.startSlotNo + Math.floor((posixMs - genesis.systemStartPosixMs) / genesis.slotLengthMs);
}
