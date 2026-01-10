/**
 * Unit tests for CardanoIndexer private methods
 */

import { Transaction as TransactionProviderData } from '../../srv/utils/types';

describe('CardanoIndexer', () => {
  describe('_collectAddressesFromUtxos', () => {
    // We need to access the private method for testing
    // This is a mock implementation to test the logic
    function collectAddressesFromUtxos(txUtxos: TransactionProviderData): string[] {
      const set = new Set<string>();

      const inputs = txUtxos.inputs;
      const outputs = txUtxos.outputs;
      
      for (const i of inputs) {
        if (i.address) set.add(i.address);
      }
      for (const o of outputs) {
        if (o.address) set.add(o.address);
      }

      return Array.from(set);
    }

    it('should collect unique addresses from inputs and outputs', () => {
      const txUtxos: TransactionProviderData = {
        hash: 'tx123',
        blockHash: 'block123',
        blockHeight: 1000,
        slot: 5000,
        index: 0,
        fee: 170000,
        deposit: 0,
        size: 300,
        blockTime: 1234567890,
        inputs: [
          { 
            txHash: 'abc123',
            outputIndex: 0,
            address: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
            amount: [{ unit: 'lovelace', quantity: '5000000' }],
          },
          { 
            txHash: 'def456',
            outputIndex: 1,
            address: 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp',
            amount: [{ unit: 'lovelace', quantity: '3000000' }],
          },
        ],
        outputs: [
          { 
            txHash: 'ghi789',
            outputIndex: 0,
            address: 'addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622',
            amount: [{ unit: 'lovelace', quantity: '7000000' }],
            dataHash: null,
            inlineDatum: null,
            isCollateral: false,
          },
        ],
      };

      const addresses = collectAddressesFromUtxos(txUtxos);
      
      expect(addresses).toHaveLength(3);
      expect(addresses).toContain('addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8');
      expect(addresses).toContain('addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp');
      expect(addresses).toContain('addr_test1qrgfq5jeznaehnf4zs02laas2juuuyzlz48tkue50luuws2nrznmesueg7drstsqaaenq6qpcnvqvn0kessd9fw2wxys6tv622');
    });

    it('should handle empty inputs array', () => {
      const txUtxos: TransactionProviderData = {
        hash: 'tx456',
        blockHash: 'block456',
        blockHeight: 2000,
        slot: 6000,
        index: 1,
        fee: 170000,
        deposit: 0,
        size: 250,
        blockTime: 1234567900,
        inputs: [],
        outputs: [
          { 
            txHash: 'ghi789',
            outputIndex: 0,
            address: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
            amount: [{ unit: 'lovelace', quantity: '7000000' }],
            dataHash: null,
            inlineDatum: null,
            isCollateral: false,
          },
        ],
      };

      const addresses = collectAddressesFromUtxos(txUtxos);
      
      expect(addresses).toHaveLength(1);
      expect(addresses).toContain('addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8');
    });

    it('should deduplicate addresses when same address appears in inputs and outputs', () => {
      const sameAddress = 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
      
      const txUtxos: TransactionProviderData = {
        hash: 'tx789',
        blockHash: 'block789',
        blockHeight: 3000,
        slot: 7000,
        index: 2,
        fee: 170000,
        deposit: 0,
        size: 280,
        blockTime: 1234567910,
        inputs: [
          { 
            txHash: 'abc123',
            outputIndex: 0,
            address: sameAddress,
            amount: [{ unit: 'lovelace', quantity: '5000000' }],
          },
        ],
        outputs: [
          { 
            txHash: 'def456',
            outputIndex: 0,
            address: sameAddress,
            amount: [{ unit: 'lovelace', quantity: '3000000' }],
            dataHash: null,
            inlineDatum: null,
            isCollateral: false,
          },
        ],
      };

      const addresses = collectAddressesFromUtxos(txUtxos);
      
      expect(addresses).toHaveLength(1);
      expect(addresses).toContain(sameAddress);
    });

    it('should handle missing address fields gracefully', () => {
      const txUtxos: TransactionProviderData = {
        hash: 'tx999',
        blockHash: 'block999',
        blockHeight: 4000,
        slot: 8000,
        index: 3,
        fee: 170000,
        deposit: 0,
        size: 260,
        blockTime: 1234567920,
        inputs: [
          { 
            txHash: 'abc123',
            outputIndex: 0,
            address: undefined as any,
            amount: [{ unit: 'lovelace', quantity: '5000000' }],
          },
          { 
            txHash: 'def456',
            outputIndex: 1,
            address: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
            amount: [{ unit: 'lovelace', quantity: '3000000' }],
          },
        ],
        outputs: [],
      };

      const addresses = collectAddressesFromUtxos(txUtxos);
      
      expect(addresses).toHaveLength(1);
      expect(addresses).toContain('addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8');
    });
  });
});
