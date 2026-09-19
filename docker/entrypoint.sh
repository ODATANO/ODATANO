#!/bin/sh
# Image entrypoint: CDS_CONFIG (auth) from the environment, then node as PID 1
# so SIGTERM reaches the server (an npm wrapper would swallow it).
set -eu

if [ -z "${CDS_CONFIG:-}" ]; then
    CDS_CONFIG="$(node /app/docker/cds-config.mjs)" || exit 2
    export CDS_CONFIG
fi

exec node /app/node_modules/@sap/cds/bin/serve.js srv "$@"
