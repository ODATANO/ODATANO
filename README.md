# ODATANO

## Installation

### 1. Clone & Install

```bash
git clone <repository-url>
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
BLOCKFROST_KEY=your_api_key_here        # Blockfrost API key (optional)
NODE_ENV=development                     # development or production
LOG_LEVEL=debug                          # debug, info, warn, error
CACHE_TTL=300                            # Cache time-to-live in seconds
PORT=4004                                # Server port
```

### 3. Start Server

```bash
cds watch
```

**Server should now be running at:** `http://localhost:4004`

## Main Cardano Endpoints

### 1. Get Transaction Details

```bash
POST /GetTransactionByHash
Body: {"hash": "0000...0000"}  # 64-char hex
```

**Response:** Transaction with inputs, outputs, fee, etc.

### 2. Check Address Balance

```bash
POST /GetAddressByBech32
Body: {"bech32": "addr_test1q..."}
```

**Response:** Address balance and token holdings

### 3. Query Transaction Metadata

```bash
POST /GetMetadataByTx
Body: {"hash": "0000...0000"}  # 64-char hex
```
