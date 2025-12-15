import {
  mapNetworkInfo,
  mapLatestBlock,
  mapLatestEpoch,
  mapTransaction,
  mapAddress,
  mapAddressUtxos,
  mapAddressAssets,
  mapTransactionInputs,
  mapTransactionOutputs,
  mapTransactionInputAssets,
  mapTransactionOutputAssets,
  mapTransactionMetadata,
} from '../../srv/utils/mappers';
import type {
  Network,
  LatestBlock,
  LatestEpoch,
  Transaction,
  Address,
  UTxO,
  Amount,
  TxInputLine,
  TxOutputLine,
  MetadataLabelTx,
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

      expect(result.network).toBe('preview');
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
      expect(result.slotLeader).toBe('123456789');
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

  describe('mapAddressUtxos', () => {
    test('maps UTxO array correctly', () => {
      const address = 'addr_test1qz123';
      const validFrom = '2024-12-01T00:00:00Z';
      const validTo = '2024-12-31T23:59:59Z';
      const utxoData: UTxO[] = [
        {
          txHash: 'a'.repeat(64),
          outputIndex: 0,
          address: address,
          blockHash: 'b'.repeat(64),
          datumHash: 'datum123',
          scriptRef: null,
          amount: [{ unit: 'lovelace', quantity: '2000000' }],
        },
        {
          txHash: 'c'.repeat(64),
          outputIndex: 1,
          address: address,
          blockHash: 'd'.repeat(64),
          datumHash: null,
          scriptRef: 'script456',
          amount: [{ unit: 'lovelace', quantity: '5000000' }],
        },
      ];

      const result = mapAddressUtxos(address, validFrom, validTo, utxoData);

      expect(result).toHaveLength(2);
      expect(result[0].address_address).toBe(address);
      expect(result[0].hash).toBe('a'.repeat(64));
      expect(result[0].index).toBe(0);
      expect(result[0].utxodata_dataHash).toBe('datum123');
      expect(result[0].utxodata_referenceScriptHash).toBeNull();
      expect(result[1].hash).toBe('c'.repeat(64));
      expect(result[1].utxodata_referenceScriptHash).toBe('script456');
    });

    test('returns empty array for non-array input', () => {
      const result = mapAddressUtxos('addr', '2024-12-01', '2024-12-31', null as any);
      expect(result).toEqual([]);
    });
  });

  describe('mapAddressAssets', () => {
    test('maps assets correctly and filters lovelace', () => {
      const address = 'addr_test1qz123';
      const validFrom = '2024-12-01T00:00:00Z';
      const validTo = '2024-12-31T23:59:59Z';
      const assets: Amount[] = [
        { unit: 'lovelace', quantity: '5000000' },
        { unit: '7eae28af48c06b8b28b7a32a14c3f6cc8f4e5aa9d9e2c4b1a8f7e6d5' + Buffer.from('SUNDAE').toString('hex'), quantity: '1000' },
        { unit: 'c'.repeat(56) + Buffer.from('Token').toString('hex'), quantity: '500' },
      ];

      const result = mapAddressAssets(address, validFrom, validTo, assets);

      expect(result).toHaveLength(2); // lovelace filtered out
      expect(result[0].address_address).toBe(address);
      expect(result[0].asset_policyId).toBe('7eae28af48c06b8b28b7a32a14c3f6cc8f4e5aa9d9e2c4b1a8f7e6d5');
      expect(result[0].asset_assetName).toBe('SUNDAE');
      expect(result[0].asset_quantity).toBe(1000);
      expect(result[1].asset_assetName).toBe('Token');
    });

    test('returns empty array for non-array input', () => {
      const result = mapAddressAssets('addr', '2024-12-01', '2024-12-31', null as any);
      expect(result).toEqual([]);
    });
  });

  describe('mapTransactionInputs', () => {
    test('maps transaction inputs correctly', () => {
      const txHash = 'a'.repeat(64);
      const inputs: TxInputLine[] = [
        {
          address: 'addr_test1qz123',
          txHash: txHash,
          outputIndex: 0,
          amount: [{ unit: 'lovelace', quantity: '10000000' }],
          dataHash: 'datum123',
          inlineDatum: null,
          referenceScriptHash: null,
          isCollateral: false,
          isReference: false,
        },
        {
          address: 'addr_test1qz456',
          txHash: txHash,
          outputIndex: 1,
          amount: [{ unit: 'lovelace', quantity: '5000000' }],
          dataHash: null,
          inlineDatum: 'inline123',
          referenceScriptHash: 'script456',
          isCollateral: true,
          isReference: false,
        },
      ];

      const result = mapTransactionInputs(txHash, inputs);

      expect(result).toHaveLength(2);
      expect(result[0].tx_hash).toBe(txHash);
      expect(result[0].inputIndex).toBe(0);
      expect(result[0].address_address).toBe('addr_test1qz123');
      expect(result[0].utxoData_dataHash).toBe('datum123');
      expect(result[0].isCollateral).toBe(false);
      expect(result[1].isCollateral).toBe(true);
      expect(result[1].utxoData_inlineDatum).toBe('inline123');
    });

    test('returns empty array for non-array input', () => {
      const result = mapTransactionInputs('hash', null as any);
      expect(result).toEqual([]);
    });
  });

  describe('mapTransactionOutputs', () => {
    test('maps transaction outputs correctly', () => {
      const txHash = 'b'.repeat(64);
      const outputs: TxOutputLine[] = [
        {
          address: 'addr_test1qz789',
          txHash: txHash,
          outputIndex: 0,
          amount: [{ unit: 'lovelace', quantity: '8000000' }],
          dataHash: null,
          inlineDatum: null,
          isCollateral: false,
          referenceScriptHash: null,
        },
        {
          address: 'addr_test1qz012',
          txHash: txHash,
          outputIndex: 1,
          amount: [{ unit: 'lovelace', quantity: '2000000' }],
          dataHash: 'datum789',
          inlineDatum: null,
          isCollateral: false,
          referenceScriptHash: 'script789',
        },
      ];

      const result = mapTransactionOutputs(txHash, outputs);

      expect(result).toHaveLength(2);
      expect(result[0].tx_hash).toBe(txHash);
      expect(result[0].outputIndex).toBe(0);
      expect(result[0].address_address).toBe('addr_test1qz789');
      expect(result[1].utxo_dataHash).toBe('datum789');
      expect(result[1].utxo_referenceScriptHash).toBe('script789');
    });

    test('returns empty array for non-array input', () => {
      const result = mapTransactionOutputs('hash', null as any);
      expect(result).toEqual([]);
    });
  });

  describe('mapTransactionInputAssets', () => {
    test('maps input assets including lovelace and native tokens', () => {
      const txHash = 'c'.repeat(64);
      const inputs: TxInputLine[] = [
        {
          address: 'addr1',
          txHash: txHash,
          outputIndex: 0,
          amount: [
            { unit: 'lovelace', quantity: '10000000' },
            { unit: 'a'.repeat(56) + Buffer.from('TOKEN1').toString('hex'), quantity: '500' },
          ],
          dataHash: null,
          inlineDatum: null,
          referenceScriptHash: null,
          isCollateral: false,
          isReference: false,
        },
      ];

      const result = mapTransactionInputAssets(txHash, inputs);

      expect(result).toHaveLength(2);
      expect(result[0].input_tx_hash).toBe(txHash);
      expect(result[0].input_inputIndex).toBe(0);
      expect(result[0].unit).toBe('lovelace');
      expect(result[0].asset_assetName).toBe('lovelace');
      expect(result[0].asset_policyId).toBeNull();
      expect(result[0].asset_quantity).toBe(10000000);
      expect(result[1].asset_assetName).toBe('TOKEN1');
      expect(result[1].asset_policyId).toBe('a'.repeat(56));
    });

    test('returns empty array when inputs have no amounts', () => {
      const inputs: TxInputLine[] = [
        {
          address: 'addr1',
          txHash: 'hash',
          outputIndex: 0,
          amount: [],
          dataHash: null,
          inlineDatum: null,
          referenceScriptHash: null,
          isCollateral: false,
          isReference: false,
        },
      ];

      const result = mapTransactionInputAssets('hash', inputs);
      expect(result).toEqual([]);
    });
  });

  describe('mapTransactionOutputAssets', () => {
    test('maps output assets including lovelace and native tokens', () => {
      const txHash = 'd'.repeat(64);
      const outputs: TxOutputLine[] = [
        {
          address: 'addr2',
          txHash: txHash,
          outputIndex: 0,
          amount: [
            { unit: 'lovelace', quantity: '5000000' },
            { unit: 'b'.repeat(56) + Buffer.from('TOKEN2').toString('hex'), quantity: '1000' },
          ],
          dataHash: null,
          inlineDatum: null,
          isCollateral: false,
          referenceScriptHash: null,
        },
      ];

      const result = mapTransactionOutputAssets(txHash, outputs);

      expect(result).toHaveLength(2);
      expect(result[0].output_tx_hash).toBe(txHash);
      expect(result[0].output_outputIndex).toBe(0);
      expect(result[0].unit).toBe('lovelace');
      expect(result[0].asset_assetName).toBe('lovelace');
      expect(result[0].asset_policyId).toBeNull();
      expect(result[1].asset_assetName).toBe('TOKEN2');
      expect(result[1].asset_quantity).toBe(1000);
    });

    test('returns empty array for non-array input', () => {
      const result = mapTransactionOutputAssets('hash', null as any);
      expect(result).toEqual([]);
    });
  });

  describe('mapTransactionMetadata', () => {
    test('maps transaction metadata array correctly', () => {
      const metadataData: MetadataLabelTx[] = [
        {
          txHash: 'f'.repeat(64),
          label: 721,
          json: { name: 'NFT1' },
        },
      ];

      const result = mapTransactionMetadata(metadataData);

      expect(result).toHaveLength(1);
      expect(result[0].tx_hash).toBe('f'.repeat(64));
      expect(result[0].label).toBe('721');
      expect(result[0].payload).toBe(JSON.stringify({ name: 'NFT1' }));
    });

    test('filters out non-numeric labels', () => {
      const metadataData: MetadataLabelTx[] = [
        {
          txHash: 'g'.repeat(64),
          label: 'invalid',
          json: { someKey: 'someValue' },
        },
      ];

      const result = mapTransactionMetadata(metadataData);
      expect(result).toHaveLength(0);
    });

    test('returns empty array for non-array input', () => {
      const result = mapTransactionMetadata(null as any);
      expect(result).toEqual([]);
    });
  });
});


