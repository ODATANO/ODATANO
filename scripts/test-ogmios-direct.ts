import cardano from '../srv/blockchain/cardano-client';

const TEST_ADDRESS = 'addr_test1vqm5vyp8xztmxyl6mcr2xr5schajvsq8fjs8gn8g2zu0pgg8gckcp';

async function main() {
  try {
    console.log('Testing Ogmios direct UTxO query...');
    console.log('Address:', TEST_ADDRESS);
    
    const utxos = await cardano.getAddressUtxos(TEST_ADDRESS);
    
    console.log('\n✅ UTxOs found:', utxos.length);
    
    if (utxos.length > 0) {
      console.log('\nFirst UTxO:');
      console.log('  TX Hash:', utxos[0].txHash);
      console.log('  Index:', utxos[0].outputIndex);
      console.log('  Amount:', utxos[0].amount);
    }
    
    const totalLovelace = utxos.reduce((sum, u) => {
      const lovelace = u.amount.find(a => a.unit === 'lovelace');
      return sum + BigInt(lovelace?.quantity || '0');
    }, 0n);
    
    console.log('\nTotal:', (Number(totalLovelace) / 1_000_000).toFixed(6), 'ADA');
    
  } catch (error: any) {
    console.error('Error:', error.message);
    console.error(error);
  } finally {
    process.exit(0);
  }
}

main();
