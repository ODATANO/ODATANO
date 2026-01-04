import cardano from '../srv/blockchain/cardano-client';

async function main() {
  try {
    console.log('Testing Ogmios Protocol Parameters...');
    
    const params = await cardano.getProtocolParameters();
    
    console.log('\n✅ Protocol Parameters retrieved successfully!');
    console.log('Network:', params.network);
    console.log('Min Fee A:', params.minFeeA);
    console.log('Min Fee B:', params.minFeeB);
    console.log('Max TX Size:', params.maxTxSize);
    console.log('Protocol Version:', params.protocolMajorVer + '.' + params.protocolMinorVer);
    
  } catch (error: any) {
    console.error('Error:', error.message);
    console.error(error);
  } finally {
    process.exit(0);
  }
}

main();
