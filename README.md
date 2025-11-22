# ODATANO

## Installation

### 1. Clone & Install

```bash
git clone https://github.com/ODATANO/ODATANO
cd ODATANO
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env
```

**Configuration (.env):**

```env
# Blockfrost API key ( get more infos on https://blockfrost.io )
BLOCKFROST_KEY=your_api_key_here

# Timeout settings (milliseconds)
PRIMARY_TIMEOUT_MS=8000
FALLBACK_TIMEOUT_MS=8000

# Data Age settings
ADDR_MAX_AGE_MIN=1
```

### 3. Create Local Sqlight DB

```bash
cds deploy
```

### 4. Start Server

```bash
cds watch
```

**Server should now be running at:** `http://localhost:4004`

## Main Cardano Endpoints

### 1. Get Transaction Details http://localhost:4004/odata/v4/cardano-odata/Transactions('tx hash')

#### Example Call:

```bash
curl "http://localhost:4004/odata/v4/cardano-odata/Transactions('1932fa826ee085666c012b7e464562e455309b33637af2929a9c1cdd00842c2a')"
```

**Response:** Transaction with inputs, outputs, fee, etc.

```bash
StatusCode        : 200
StatusDescription : OK
Content           : {"@odata.context":"$metadata#Transactions/$entity","hash
                    ":"1932fa826ee085666c012b7e464562e455309b33637af2929a9c1
                    cdd00842c2a","blockHash":"6645ec303472c2ed2f18d16e9b9b15
                    889412ab4756045beb45874716870a97...
RawContent        : HTTP/1.1 200 OK
                    X-Correlation-ID: 63365bf9-0226-40e3-99c7-663ea29dfc85
                    OData-Version: 4.0
                    Connection: keep-alive
                    Keep-Alive: timeout=5
                    Content-Length: 527
                    Content-Type: application/json; charset...
Forms             : {}
Headers           : {[X-Correlation-ID,
                    63365bf9-0226-40e3-99c7-663ea29dfc85], [OData-Version,
                    4.0], [Connection, keep-alive], [Keep-Alive,
                    timeout=5]...}
Images            : {}
InputFields       : {}
Links             : {}
ParsedHtml        : mshtml.HTMLDocumentClass
RawContentLength  : 527
```

### 2. Check Addresses http://localhost:4004/odata/v4/cardano-odata/Addresses('bench32 address')

#### Example Call:

```bash
curl "http://localhost:4004/odata/v4/cardano-odata/Addresses('addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8')"
```

**Response:** Address balance and token holdings

```bash
StatusCode        : 200
StatusDescription : OK
Content           : {"@odata.context":"$metadata#Addresses/$entity","bech32"
                    :"addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zu
                    xxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8",
                    "stakeAddress":"stake_test1uzkws...
RawContent        : HTTP/1.1 200 OK
                    X-Correlation-ID: d1d5ceb9-d973-4fec-8a93-e4ac0eef8a9b
                    OData-Version: 4.0
                    Connection: keep-alive
                    Keep-Alive: timeout=5
                    Content-Length: 389
                    Content-Type: application/json; charset...
Forms             : {}
Headers           : {[X-Correlation-ID,
                    d1d5ceb9-d973-4fec-8a93-e4ac0eef8a9b], [OData-Version,
                    4.0], [Connection, keep-alive], [Keep-Alive,
                    timeout=5]...}
Images            : {}
InputFields       : {}
Links             : {}
ParsedHtml        : mshtml.HTMLDocumentClass
RawContentLength  : 389
```
