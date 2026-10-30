# Simple Docker build for ODATANO - matches CI setup
FROM node:22.23.4-alpine

# Build arguments for versioning
ARG VERSION=0.1.0
ARG BUILD_DATE
ARG VCS_REF

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# --ignore-scripts is required. The prepare script runs tsc, which fails with TS5058
# while only the manifests exist. The real build runs below, after the source is copied.
RUN npm ci --ignore-scripts

# Copy source code
COPY . .

# Best-effort native build of the optional pkcs11js. Alpine has no gyp toolchain,
# so it fails and HSM is unavailable in this image. No other dependency needs install scripts.
RUN npm rebuild pkcs11js || echo "pkcs11js native build skipped (optional; HSM unavailable in this image)"

# Compile TypeScript in place. `cds serve srv` resolves each @impl as srv/<name>.js next to its .cds,
# and the runtime image has no TypeScript loader. `npm run build` emits into dist/, which nothing serves.
RUN npm run build:plugin

# Deploy database
RUN npm run db:deploy

# The DB adapters are devDependencies but this image serves from one, so both are re-added after the prune.
# Deleting the devDependencies block first is required. Otherwise the install restores every dev
# dependency, and --omit=dev would drop the sqlite adapter itself.
RUN npm prune --omit=dev \
 && npm pkg delete devDependencies \
 && npm install --no-save --ignore-scripts @cap-js/sqlite@^3 @cap-js/postgres@^3

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

# /data holds the SQLite file on a fresh volume; the runtime user must own it.
RUN chmod +x /app/docker/entrypoint.sh && mkdir -p /data && chown node:node /data

# Run as non-root user for security
USER node

# Expose port
EXPOSE 4004

# getLiveness() answers without credentials under every auth kind. The service document
# would return 401 to the probe and leave the container unhealthy for good.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://localhost:4004/odata/v4/cardano-indexer/getLiveness()" || exit 1

# Start service: the entrypoint builds CDS_CONFIG (auth) from the environment and
# execs node as PID 1 (docker/cds-config.mjs, docker/entrypoint.sh).
ENTRYPOINT ["/app/docker/entrypoint.sh"]
