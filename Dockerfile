# Simple Docker build for ODATANO - matches CI setup
FROM node:22-alpine

# Build arguments for versioning
ARG VERSION=0.1.0
ARG BUILD_DATE
ARG VCS_REF

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install ALL dependencies (needed for build). --ignore-scripts is REQUIRED here:
# the package's `prepare` lifecycle runs `tsc -p tsconfig.build.json`, but at this
# layer only the manifests exist — the compile would fail with TS5058. The real
# build runs explicitly below once the source has been copied.
RUN npm ci --ignore-scripts

# Copy source code
COPY . .

# Best-effort native build for the OPTIONAL pkcs11js dependency (skipped by
# --ignore-scripts above). Alpine has no gyp toolchain, so this fails and HSM
# stays unavailable in this image — exactly as before, where npm ci silently
# skipped the failing optional dep. Everything else needs no install scripts
# (sqlite is node:sqlite, blake2b is wasm, esbuild is dev-only).
RUN npm rebuild pkcs11js || echo "pkcs11js native build skipped (optional; HSM unavailable in this image)"

# Generate CDS types and compile TypeScript
RUN npm run build

# Deploy database
RUN npm run db:deploy

# Remove devDependencies to reduce image size and avoid plugin conflicts.
# @cap-js/sqlite is a devDependency of the npm package (consumers pick their own
# DB adapter), but THIS image serves from sqlite — re-add it after the prune,
# otherwise cds-serve crashes at startup with MODULE_NOT_FOUND.
RUN npm prune --omit=dev && npm install --no-save --ignore-scripts @cap-js/sqlite@^3

# Add metadata labels
LABEL org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.title="ODATANO" \
      org.opencontainers.image.description="SAP CAP OData service for Cardano blockchain" \
      org.opencontainers.image.vendor="ODATANO"

# Set version as environment variable (accessible at runtime)
ENV APP_VERSION=${VERSION}

# The build steps above ran as root; the runtime user is `node`. SQLite needs
# write access to the DB file AND the directory (WAL/journal files), otherwise
# startup dies with "attempt to write a readonly database".
RUN chown node:node /app /app/*.sqlite* 2>/dev/null || chown node:node /app

# Run as non-root user for security
USER node

# Expose port
EXPOSE 4004

# Health check — the index page is served unauthenticated; $metadata is NOT
# (mocked/XSUAA auth returns 401 for anonymous requests, which would leave the
# container permanently "unhealthy").
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:4004/ || exit 1

# Start service - serve all CDS files explicitly
CMD ["node", "node_modules/@sap/cds/bin/serve.js", "srv"]
