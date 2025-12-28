# Docker Deployment Guide

## Quick Start

```bash
# 1. Set your API key
echo "BLOCKFROST_API_KEY=your-api-key-here" > .env

# 2. Start
docker-compose up -d

# 3. Test
curl http://localhost:4004/health
```

Service runs at `http://localhost:4004`

## Configuration

Edit `.env`:

```env
BLOCKFROST_API_KEY=your-api-key
CARDANO_NETWORK=preview  # or mainnet, preprod
```

## Common Commands

```bash
# Start
docker-compose up -d

# Logs
docker-compose logs -f

# Stop
docker-compose down

# Rebuild
docker-compose up -d --build

# Clean everything
docker-compose down -v
```

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `CARDANO_NETWORK` | Network to connect to (mainnet/preview/preprod) | `preview` | Yes |
| `CARDANO_PROVIDER` | Primary provider (blockfrost/koios) | `blockfrost` | Yes |
| `BLOCKFROST_API_KEY` | Blockfrost API key | - | Yes* |
| `KOIOS_API_URL` | Koios API endpoint | `https://api.koios.rest/api/v1` | No |
| `CDS_LOG_LEVEL` | Logging level (error/warn/info/debug/trace) | `info` | No |
| `NODE_ENV` | Node environment | `production` | No |
| `PORT` | Service port | `4004` | No |

\* Required when using Blockfrost as provider

### Volume Mounts

The docker-compose configuration includes a persistent volume for the SQLite database:

```yaml
volumes:
  - odatano-data:/app
```

This ensures data persists across container restarts.

## Publishing Pre-built Image (Optional)

To make ODATANO available as a "just run" image without building:

### Publish to Docker Hub

```bash
# Login to Docker Hub
docker login

# Tag the image
docker tag odatano:latest yourusername/odatano:latest
docker tag odatano:latest yourusername/odatano:1.0.0

# Push to Docker Hub
docker push yourusername/odatano:latest
docker push yourusername/odatano:1.0.0
```

### Publish to GitHub Container Registry

```bash
# Login to GitHub Container Registry
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin

# Tag the image
docker tag odatano:latest ghcr.io/odatano/odatano:latest
docker tag odatano:latest ghcr.io/odatano/odatano:1.0.0

# Push to GHCR
docker push ghcr.io/odatano/odatano:latest
docker push ghcr.io/odatano/odatano:1.0.0
```

### Using Pre-built Image

Update `docker-compose.yml` to use the published image:

```yaml
services:
  odatano:
    image: ghcr.io/odatano/odatano:latest  # or yourusername/odatano:latest
    # Remove the 'build' section
```

Then users can just run:

```bash
docker-compose up -d
```

Without needing to build anything!

## Production Deployment

### 1. Use Docker Secrets (Recommended)

For production, use Docker secrets instead of environment variables:

```bash
echo "your-api-key" | docker secret create blockfrost_api_key -
```

Update docker-compose.yml:

```yaml
services:
  odatano:
    secrets:
      - blockfrost_api_key
    environment:
      - BLOCKFROST_API_KEY_FILE=/run/secrets/blockfrost_api_key

secrets:
  blockfrost_api_key:
    external: true
```

### 2. Configure Reverse Proxy

For production, use a reverse proxy like Nginx:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:4004;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 3. Enable HTTPS

Use Let's Encrypt for free SSL certificates:

```bash
# Install certbot
apt-get install certbot python3-certbot-nginx

# Obtain certificate
certbot --nginx -d your-domain.com
```

### 4. Resource Limits

Set resource limits in docker-compose.yml:

```yaml
services:
  odatano:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
```

## Cloud Deployment

### AWS ECS

1. Push image to ECR:

```bash
aws ecr create-repository --repository-name odatano
docker tag odatano:latest <account-id>.dkr.ecr.<region>.amazonaws.com/odatano:latest
docker push <account-id>.dkr.ecr.<region>.amazonaws.com/odatano:latest
```

2. Create ECS task definition and service using the AWS Console or CLI

### Azure Container Instances

```bash
# Create resource group
az group create --name odatano-rg --location eastus

# Create container
az container create \
  --resource-group odatano-rg \
  --name odatano \
  --image odatano:latest \
  --dns-name-label odatano \
  --ports 4004 \
  --environment-variables \
    CARDANO_NETWORK=preview \
    BLOCKFROST_API_KEY=your-api-key
```

### Google Cloud Run

```bash
# Build and push to GCR
gcloud builds submit --tag gcr.io/PROJECT-ID/odatano

# Deploy
gcloud run deploy odatano \
  --image gcr.io/PROJECT-ID/odatano \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars CARDANO_NETWORK=preview,BLOCKFROST_API_KEY=your-api-key
```

## Monitoring and Logs

### View Logs

```bash
# Follow logs
docker-compose logs -f odatano

# View last 100 lines
docker-compose logs --tail=100 odatano
```

### Health Checks

The container includes built-in health checks:

```bash
# Check health status
docker inspect --format='{{.State.Health.Status}}' odatano-service

# View health check history
docker inspect --format='{{json .State.Health}}' odatano-service | jq
```

## Troubleshooting

### Container Won't Start

1. Check logs:
```bash
docker-compose logs odatano
```

2. Verify environment variables:
```bash
docker-compose config
```

3. Check if port 4004 is already in use:
```bash
netstat -tulpn | grep 4004
```

### API Key Issues

Verify your Blockfrost API key:

```bash
# For preview network
curl -H "project_id: your-api-key" https://cardano-preview.blockfrost.io/api/v0/

# For mainnet
curl -H "project_id: your-api-key" https://cardano-mainnet.blockfrost.io/api/v0/
```

### Database Issues

Reset the database:

```bash
docker-compose down -v
docker-compose up -d
```

## Scaling

### Horizontal Scaling

Run multiple instances behind a load balancer:

```yaml
services:
  odatano:
    deploy:
      replicas: 3
```

### Kubernetes Deployment

Example deployment manifest:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: odatano
spec:
  replicas: 3
  selector:
    matchLabels:
      app: odatano
  template:
    metadata:
      labels:
        app: odatano
    spec:
      containers:
      - name: odatano
        image: odatano:latest
        ports:
        - containerPort: 4004
        env:
        - name: CARDANO_NETWORK
          value: "preview"  # or "mainnet" for production
        - name: BLOCKFROST_API_KEY
          valueFrom:
            secretKeyRef:
              name: odatano-secrets
              key: blockfrost-api-key
---
apiVersion: v1
kind: Service
metadata:
  name: odatano-service
spec:
  selector:
    app: odatano
  ports:
  - port: 80
    targetPort: 4004
  type: LoadBalancer
```

## Maintenance

### Update Image

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose build
docker-compose up -d
```

### Backup Database

```bash
# Create backup
docker cp odatano-service:/app/db.sqlite ./backup-$(date +%Y%m%d).sqlite

# Restore backup
docker cp ./backup-20231228.sqlite odatano-service:/app/db.sqlite
docker-compose restart
```

## Support

For issues and questions:
- GitHub Issues: https://github.com/ODATANO/ODATANO/issues
- Documentation: See [User Guide](USER_GUIDE.md) and [Developer Guide](DEVELOPER_GUIDE.md)
