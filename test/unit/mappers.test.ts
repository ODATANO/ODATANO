import {
  mapNetworkInfo,
  mapLatestBlock,
  mapLatestEpoch,
  mapTransaction,
  mapAddress,
} from '../../srv/utils/mappers';
import type {
  Network,
  LatestBlock,
  LatestEpoch,
  Transaction,
  Address,
} from '../../srv/utils/types';

describe('mappers', () => {
  describe('mapNetworkInfo', () => {
    test('maps provider network data correctly', () => {
      const providerData: Network = {
        supply: {
          max: '45000000000000000',
          total: '35000000000000000',
          circulating: '34000000000000000',
          locked: '500000000000000',
          treasury: '300000000000000',
          reserves: '10000000000000000',
        },
        stake: {
          live: '23000000000000000',
          active: '22000000000000000',
        },
      };

      const result = mapNetworkInfo(providerData);

      expect(result.ID).toBe(1);
      expect(result.maxSupply).toBe(45000000000000000);
      expect(result.totalSupply).toBe(35000000000000000);
      expect(result.circulatingSupply).toBe(34000000000000000);
      expect(result.lockedSupply).toBe(500000000000000);
      expect(result.treasurySupply).toBe(300000000000000);
      expect(result.reservesSupply).toBe(10000000000000000);
      expect(result.liveStake).toBe(23000000000000000);
      expect(result.activeStake).toBe(22000000000000000);
      expect(result.validFrom).toBeDefined();
      expect(result.validTo).toBeDefined();
    });
  });

  describe('mapLatestBlock', () => {
    test('maps provider block data correctly', () => {
      const providerBlockData: LatestBlock = {
        hash: 'abc123def456',
        time: 1701619200,
        height: 9876543,
        slot: 123456789,
        epoch: 450,
        epochSlot: 12345,
        slotLeader: 'pool1abc',
        size: 65432,
        txCount: 42,
        fees: '5000000',
      };

      const latestEpochData = {
        epoch: 450,
        validFrom: '2024-01-01T00:00:00Z',
        validTo: '2024-01-02T00:00:00Z',
        startTime: 1701600000,
        endTime: 1701686400,
        firstBlockTime: 1701600010,
        lastBlockTime: 1701686390,
        blockCount: 21600,
        txCount: 50000,
        output: '1000000000000',
        fees: 100000000,
        activeStake: 22000000000000000,
      };

      const result = mapLatestBlock(providerBlockData, latestEpochData);

      expect(result.hash).toBe('abc123def456');
      expect(result.height).toBe(9876543);
      expect(result.slotLeader).toBe('123456789'); // Mapped from slot, not slotLeader
      expect(result.epochNumber).toBe(450);
      expect(result.epochSlot).toBe(12345);
      expect(result.size).toBe(65432);
      expect(result.txCount).toBe(42);
      expect(result.fees).toBe(5000000);
      expect(result.validFrom).toBeDefined();
      expect(result.validTo).toBeDefined();
    });
  });

  describe('mapLatestEpoch', () => {
    test('maps provider epoch data correctly', () => {
      const providerData: LatestEpoch = {
        epoch: 450,
        start_time: 1701600000,
        end_time: 1701686400,
        first_block_time: 1701600010,
        last_block_time: 1701686390,
        block_count: 21600,
        tx_count: 50000,
        output: '1000000000000',
        fees: '100000000',
        active_stake: '22000000000000000',
      };

      const result = mapLatestEpoch(providerData);

      expect(result.epoch).toBe(450);
      expect(result.startTime).toBe(1701600000);
      expect(result.endTime).toBe(1701686400);
      expect(result.firstBlockTime).toBe(1701600010);
      expect(result.lastBlockTime).toBe(1701686390);
      expect(result.blockCount).toBe(21600);
      expect(result.txCount).toBe(50000);
      expect(result.output).toBe('1000000000000');
      expect(result.fees).toBe(100000000);
      expect(result.activeStake).toBe(22000000000000000);
      expect(result.validFrom).toBeDefined();
      expect(result.validTo).toBeDefined();
    });
  });

  describe('mapTransaction', () => {
    test('maps provider transaction data correctly', () => {
      const providerData: Transaction = {
        hash: 'a'.repeat(64),
        blockHash: 'b'.repeat(64),
        blockHeight: 9876543,
        blockTime: 1701619200,
        slot: 123456789,
        index: 5,
        fee: 500000,
        deposit: 2000000,
        size: 1234,
        utxoCount: 3,
        withdrawalCount: 0,
        mirCertCount: 0,
        delegationCount: 1,
        stakeCertCount: 0,
        poolUpdateCount: 0,
        poolRetireCount: 0,
        assetMintOrBurnCount: 2,
        redeemerCount: 0,
        validContract: true,
        inputs: [],
        outputs: [],
      };

      const result = mapTransaction(providerData);

      expect(result.hash).toBe('a'.repeat(64));
      expect(result.blockHash).toBe('b'.repeat(64));
      expect(result.blockHeight).toBe(9876543);
      expect(result.slot).toBe(123456789);
      expect(result.txIndex).toBe(5);
      expect(result.fee).toBe(500000);
      expect(result.deposit).toBe(2000000);
      expect(result.size).toBe(1234);
      expect(result.utxoCount).toBe(3);
      expect(result.withdrawalCount).toBe(0);
      expect(result.mirCertCount).toBe(0);
      expect(result.delegationCount).toBe(1);
      expect(result.stakeCertCount).toBe(0);
      expect(result.poolUpdateCount).toBe(0);
      expect(result.poolRetireCount).toBe(0);
      expect(result.assetMintOrBurnCount).toBe(2);
      expect(result.redeemerCount).toBe(0);
      expect(result.validContract).toBe(true);
      expect(result.blockTime).toBeDefined();
    });
  });

  describe('mapAddress', () => {
    test('maps provider address data correctly', () => {
      const address = 'addr_test1qz123';
      const providerData: Address = {
        address: 'addr_test1qz123',
        stakeAddress: 'stake_test1uz456',
        type: 'shelley',
        isScript: false,
        amount: [
          { unit: 'lovelace', quantity: '5000000' },
          { unit: 'abc.token1', quantity: '100' },
        ],
      };

      const result = mapAddress(address, providerData);

      expect(result.address).toBe('addr_test1qz123');
      expect(result.stakeAddress).toBe('stake_test1uz456');
      expect(result.type).toBe('shelley');
      expect(result.isScript).toBe(false);
      expect(result.totalLovelace).toBe(5000000);
      expect(result.validFrom).toBeDefined();
      expect(result.validTo).toBeDefined();
    });

    test('calculates total lovelace correctly when no lovelace in amounts', () => {
      const address = 'addr_test1qz123';
      const providerData: Address = {
        address: 'addr_test1qz123',
        stakeAddress: null,
        type: 'shelley',
        isScript: false,
        amount: [
          { unit: 'abc.token1', quantity: '100' },
        ],
      };

      const result = mapAddress(address, providerData);
      expect(result.totalLovelace).toBe(0);
    });
  });
});


