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
 * Absolute POSIX seconds for a slot via the Shelley-anchored genesis infos (exact for Shelley-era
 * slots). Ogmios' `eraStart.time` is RelativeTime since system start, not a Unix timestamp.
 */
export function slotToPosixSeconds(network: EpochNetwork, slot: number): number {
  const genesis = GENESIS_INFOS_BY_NETWORK[network];
  return Math.floor((genesis.systemStartPosixMs + (slot - genesis.startSlotNo) * genesis.slotLengthMs) / 1000);
}
