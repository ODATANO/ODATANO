# Docker Deployment

**Version:** v1.9 | **Last Updated:** June 2026

## Quick Start

### Build from Source

```bash
# 1. Clone repository
git clone https://github.com/ODATANO/ODATANO
cd ODATANO

# 2. Create .env from template
cp .env.example .env
# Edit .env and add your BLOCKFROST_API_KEY

# 3. Start (builds automatically)
docker-compose up -d

# 4. Test
curl http://localhost:4004/odata/v4/cardano-odata/NetworkInformation
```

### Use Pre-built Image

```bash
# 1. Download docker-compose.yml
curl -O https://raw.githubusercontent.com/ODATANO/ODATANO/main/docker-compose.yml

# 2. Edit docker-compose.yml and change:
#    image: odatano:0.1.0
#    to:
#    image: ghcr.io/odatano/odatano:0.1.0
#    
#    Also comment out the build: section

# 3. Create .env file
cat > .env << EOF
BLOCKFROST_API_KEY=your-blockfrost-api-key-here
NETWORK=preview
BACKENDS=blockfrost,koios
EOF

# 4. Start
docker-compose up -d
```

Service runs at `http://localhost:4004`

## Configuration

The `.env` file configures the service. Copy `.env.example` as a starting point:

```env
# Required: Blockfrost API Key (get from https://blockfrost.io)
BLOCKFROST_API_KEY=your-blockfrost-api-key-here

# Network: mainnet, preview, preprod (default: preview)
NETWORK=preview

# Backends: blockfrost, koios, or both comma-separated (default: blockfrost,koios)
BACKENDS=blockfrost,koios

# Cache TTL in milliseconds (default: 600000 = 10 minutes)
INDEX_TTL_MS=600000
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
