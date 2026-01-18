import axios, { AxiosError } from 'axios';

const COMPONENT_NAME = 'RequestExamples';

const BASE_URL = 'http://localhost:4004/odata/v4/cardano-odata';

interface ExampleRequest {
  name: string;
  method: 'GET' | 'POST';
  url: string;
  data?: any;
}

const examples: ExampleRequest[] = [
  // GET Requests - Entity Sets
  {
    name: 'GET $metadata',
    method: 'GET',
    url: `${BASE_URL}/$metadata`,
  },
  {
    name: 'GET NetworkInformation',
    method: 'GET',
    url: `${BASE_URL}/NetworkInformation`,
  },
  {
    name: 'GET Blocks',
    method: 'GET',
    url: `${BASE_URL}/Blocks('2c1db6c1d204346e21fe971755fac85d7e7d1c127e1b31075ba705d5040c0008')`,
  },
  {
    name: 'GET Epochs',
    method: 'GET',
    url: `${BASE_URL}/Epochs(500)`,
  },
  {
    name: 'GET Pools',
    method: 'GET',
    url: `${BASE_URL}/Pools('pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r')`,
  },
  {
    name: 'GET Dreps',
    method: 'GET',
    url: `${BASE_URL}/Dreps('drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0')`,
  },
  {
    name: 'GET Transactions',
    method: 'GET',
    url: `${BASE_URL}/Transactions`,
  },
  {
    name: 'GET Accounts',
    method: 'GET',
    url: `${BASE_URL}/Accounts('stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p')`,
  },
  {
    name: 'GET Addresses',
    method: 'GET',
    url: `${BASE_URL}/Addresses('addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8')`,
  },
  {
    name: 'GET TransactionMetadata',
    method: 'GET',
    url: `${BASE_URL}/TransactionMetadata(tx_hash='95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1',id=0)`,
  },

  // POST Requests - Actions
  {
    name: 'POST GetNetworkInformation',
    method: 'POST',
    url: `${BASE_URL}/GetNetworkInformation`,
    data: {},
  },
  {
    name: 'POST GetBlockByHash',
    method: 'POST',
    url: `${BASE_URL}/GetBlockByHash`,
    data: {
      hash: '2c1db6c1d204346e21fe971755fac85d7e7d1c127e1b31075ba705d5040c0008',
    },
  },
  {
    name: 'POST GetEpochByNumber',
    method: 'POST',
    url: `${BASE_URL}/GetEpochByNumber`,
    data: {
      epochNumber: 500,
    },
  },
  {
    name: 'POST GetPoolById',
    method: 'POST',
    url: `${BASE_URL}/GetPoolById`,
    data: {
      poolId: 'pool1knap9hldvhww0fjqew26sxkfjpj3c8tp8uuj7j3729lzqn9x70r',
    },
  },
  {
    name: 'POST GetDrepById',
    method: 'POST',
    url: `${BASE_URL}/GetDrepById`,
    data: {
      drepId: 'drep1y2ldnl4ugmhx873hpw7x23rvqe7krtwvgmvqjn3hy62xv6c8ashc0',
    },
  },
  {
    name: 'POST GetAccountByStakeAddress',
    method: 'POST',
    url: `${BASE_URL}/GetAccountByStakeAddress`,
    data: {
      stakeAddress: 'stake_test1urqntq4wexjylnrdnp97qq79qkxxvrsa9lcnwr7ckjd6w0cr04y4p',
    },
  },
  {
    name: 'POST GetTransactionByHash',
    method: 'POST',
    url: `${BASE_URL}/GetTransactionByHash`,
    data: {
      hash: '95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1',
    },
  },
  {
    name: 'POST GetMetadataByTxHash',
    method: 'POST',
    url: `${BASE_URL}/GetMetadataByTxHash`,
    data: {
      tx_hash: '95edd3f70ac85d6445fd5d719a66955edf3eda78c0c365004f8c28b3e9e48bb1',
    },
  },
  {
    name: 'POST GetAddressByBech32',
    method: 'POST',
    url: `${BASE_URL}/GetAddressByBech32`,
    data: {
      address: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
    },
  },
  {
    name: 'POST GetUTxOsByAddress',
    method: 'POST',
    url: `${BASE_URL}/GetUTxOsByAddress`,
    data: {
      address: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
    },
  },
  {
    name: 'POST GetAssetsByAddress',
    method: 'POST',
    url: `${BASE_URL}/GetAssetsByAddress`,
    data: {
      address: 'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8',
    },
  },
];

(async () => {
  console.log('Starting ODATANO M1 Service Catalog Tests');
  console.log(`Total Requests: ${examples.length}`);
  console.log('='.repeat(80));

  let successCount = 0;
  let errorCount = 0;

  for (const ex of examples) {
    console.log(`\n=== ${ex.name} ===`);

    try {
      const config = {
        timeout: 60_000, // Increased to 60 seconds for backend API calls
        headers: ex.method === 'POST' ? { 'Content-Type': 'application/json' } : {},
      };

      const res = ex.method === 'POST' 
        ? await axios.post(ex.url, ex.data, config)
        : await axios.get(ex.url, config);

      console.log(
        { 
          status: res.status,
          dataSize: JSON.stringify(res.data).length,
        },
        'Request successful'
      );
      successCount++;
    } catch (err: unknown) {
      const error = err as AxiosError;
      errorCount++;

      if (error.response) {
        console.log(
          {
            status: error.response.status,
            body: error.response.data,
          },
          'Request failed with response'
        );
      } else {
        console.error(
          { err: error.message },
          'Request failed with error'
        );
      }
    }
  }

  console.log('='.repeat(80));
  console.log({
    total: examples.length,
    successful: successCount,
    failed: errorCount,
  }, 'Test Summary');
})();
