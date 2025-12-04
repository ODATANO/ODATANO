# ODATANO Quick Start Guide

## Installation

### 1. Clone & Install

```bash
git clone <https://github.com/ODATANO/ODATANO>
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

### 3. Initialize Database

```bash
cds deploy --to sqlite
```

This creates the SQLite database with temporal caching tables.

### 4. Start Server

```bash
npm run cds:watch
```

**Server should now be running at:** `http://localhost:4004`

## Testing

### Run All Tests (83 tests)

```bash
# Set Blockfrost API key and run tests
$env:BLOCKFROST_KEY='your_api_key_here'; npm test

# Run with coverage report
$env:BLOCKFROST_KEY='your_api_key_here'; npm test -- --coverage
```

## First Odata Call

## Addresses

```bash
GET /odata/v4/cardano-odata/Addresses('<bech32>')
```

Or use the action:

```bash
POST /odata/v4/cardano-odata/GetAddressByBech32
Content-Type: application/json

{
  "address": "addr_test1qp..."
}
```
