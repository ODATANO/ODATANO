# Simple Docker build for ODATANO - matches CI setup
FROM node:22-alpine

WORKDIR /app

# Copy everything
COPY . .

# Install dependencies
RUN npm ci

# Generate CDS types
RUN npm run cds:types

# Compile TypeScript
RUN npx tsc

# Deploy database
RUN npm run db:deploy

# Expose port
EXPOSE 4004

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4004/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start service
CMD ["npm", "start"]
