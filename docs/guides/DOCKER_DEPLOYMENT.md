# Docker Deployment

## Quick Start

```bash
# 1. Set your API key
echo "BLOCKFROST_API_KEY=your-api-key-here" > .env

# 2. Start
docker-compose up -d

# 3. Test
curl http://localhost:4004/health
```

Service at `http://localhost:4004`

## Configuration

Edit `.env`:

```env
BLOCKFROST_API_KEY=your-api-key
CARDANO_NETWORK=preview  # or mainnet, preprod
```

## Commands

```bash
# Start
docker-compose up -d

# Logs
docker-compose logs -f

# Stop
docker-compose down
```
