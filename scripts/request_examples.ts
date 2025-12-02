import axios, { AxiosError } from 'axios';
import logger from '../srv/utils/logger';

const BASE = 'http://localhost:4004/odata/v4/cardano-odata';

interface ExampleRequest {
  name: string;
  url: string;
}

const examples: ExampleRequest[] = [
  {
    name: 'Transaction (example hash)',
    url: `${BASE}/Transactions(ID='1932fa826ee085666c012b7e464562e455309b33637af2929a9c1cdd00842c2a')`,
  },
  {
    name: 'Address (example)',
    url: `${BASE}/Addresses(address='addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8')`,
  },
  {
    name: 'Metadata (example tx)',
    url: `${BASE}/Metadata(tx='50d9ad6558a6963d72dc25b4f37f31db15a512c708bb735a8f67f30b878bd4e3')`,
  },
  {
    name: 'Latest Block',
    url: `${BASE}/LatestBlock`,
  },
  {
    name: 'Network Information',
    url: `${BASE}/NetworkInformation`,
  },
  {
    name: 'Latest Epoch',
    url: `${BASE}/LatestEpoch`,
  },  
];

(async () => {
  for (const ex of examples) {
    logger.info({ name: ex.name }, `=== ${ex.name} ===`);

    try {
      const res = await axios.get(ex.url, { timeout: 10_000 });
      logger.info(
        { status: res.status, data: res.data },
        'request result'
      );
    } catch (err: unknown) {
      const error = err as AxiosError;

      if (error.response) {
        logger.warn(
          {
            status: error.response.status,
            body: error.response.data,
          },
          'request warning'
        );
      } else {
        logger.error(
          { err: error.message },
          'request error'
        );
      }
    }
  }
})();
