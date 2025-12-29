# Simple Docker build for ODATANO - matches CI setup
FROM node:22-alpine

# Build arguments for versioning
ARG VERSION=0.1.0
ARG BUILD_DATE
ARG VCS_REF

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install ALL dependencies (needed for build)
RUN npm ci

# Copy source code
COPY . .

# Generate CDS types and compile TypeScript
RUN npm run build

# Deploy database
RUN npm run db:deploy

# Remove devDependencies to reduce image size and avoid plugin conflicts
RUN npm prune --omit=dev

# Add metadata labels
LABEL org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.title="ODATANO" \
      org.opencontainers.image.description="SAP CAP OData service for Cardano blockchain" \
      org.opencontainers.image.vendor="ODATANO"

# Set version as environment variable (accessible at runtime)
ENV APP_VERSION=${VERSION}

# Expose port
EXPOSE 4004

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:4004/\$metadata || exit 1

# Start service - serve all CDS files explicitly
CMD ["node", "node_modules/@sap/cds/bin/serve.js", "srv"]
