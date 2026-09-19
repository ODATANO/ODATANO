#!/bin/sh
# Image entrypoint: CDS_CONFIG (db + auth) from the environment
# (docker/cds-config.mjs), the schema, then node as PID 1 so SIGTERM reaches
# the server.
#
#   ODATANO_DB_URL=postgres://user:pw@host:5432/db -> PostgreSQL; the schema is
#       deployed on EVERY boot (CAP's evolution is additive, an image upgrade
#       brings its columns with it). ODATANO_DB_DEPLOY=never skips that.
#   otherwise -> SQLite at ODATANO_DB_PATH (default /data/db.sqlite), seeded on
#       the first boot from the schema the image build deployed (/app/db.sqlite).
#
# `migrate` mode: deploy the schema into PostgreSQL and copy a SQLite file into
# it, then exit. Run it as a one-off container BEFORE the first PostgreSQL start
# of the service, with every writer stopped:
#   ODATANO_DB_URL=postgres://... docker compose run --rm --no-deps odatano migrate --from /data/db.sqlite
set -eu

DB_URL="${ODATANO_DB_URL:-}"
DB_PATH="${ODATANO_DB_PATH:-/data/db.sqlite}"
MODE="${1:-serve}"

wait_for_postgres() {
    node -e '
        const { host, port } = JSON.parse(process.env.CDS_CONFIG).requires.db.credentials;
        const waitSeconds = Number(process.env.ODATANO_DB_WAIT_SECONDS ?? "60");
        if (!Number.isFinite(waitSeconds) || waitSeconds <= 0 || waitSeconds > 86400) { console.error("FATAL: ODATANO_DB_WAIT_SECONDS must be 1..86400"); process.exit(1); }
        const net = require("net"); const deadline = Date.now() + 1000 * waitSeconds;
        (function attempt() {
            const left = deadline - Date.now();
            if (left <= 0) { console.error(`FATAL: PostgreSQL at ${host}:${port} not reachable within ${waitSeconds}s`); process.exit(1); }
            const s = net.connect({ host, port }, () => { s.destroy(); process.exit(0); });
            s.setTimeout(Math.min(left, 5000), () => s.destroy(new Error("timeout")));
            s.on("error", () => { s.destroy(); setTimeout(attempt, Math.min(1000, Math.max(0, deadline - Date.now()))); });
        })();
    '
}

if [ "$MODE" = "migrate" ]; then
    shift
    if [ -z "$DB_URL" ]; then
        echo "FATAL: migrate needs ODATANO_DB_URL (the PostgreSQL target)." >&2
        exit 1
    fi
    CDS_CONFIG="$(node /app/docker/cds-config.mjs --db-only)" || exit 1
    export CDS_CONFIG
    wait_for_postgres
    echo "Deploying schema to PostgreSQL, then migrating: $*"
    node /app/node_modules/@sap/cds/bin/deploy.js
    exec node --no-warnings=ExperimentalWarning /app/scripts/migrate-sqlite-to-postgres.mjs --to "$DB_URL" "$@"
fi

[ "$MODE" = "serve" ] && [ $# -gt 0 ] && shift

if [ -z "${CDS_CONFIG:-}" ]; then
    CDS_CONFIG="$(node /app/docker/cds-config.mjs)" || exit 2
    export CDS_CONFIG
fi

if [ -n "$DB_URL" ]; then
    DB_LABEL="postgres ($(printf '%s' "$DB_URL" | sed -E 's#://([^:/@]*)(:[^@]*)?@#://\1:***@#'))"
    wait_for_postgres
    if [ "${ODATANO_DB_DEPLOY:-auto}" != "never" ]; then
        echo "Deploying schema to PostgreSQL (additive evolution; ODATANO_DB_DEPLOY=never skips this)"
        node /app/node_modules/@sap/cds/bin/deploy.js
    fi
else
    DB_LABEL="sqlite ($DB_PATH)"
    mkdir -p "$(dirname "$DB_PATH")"
    if [ ! -f "$DB_PATH" ]; then
        echo "First boot: seeding $DB_PATH from the image's deployed schema"
        cp /app/db.sqlite "$DB_PATH"
    fi
fi

echo "Starting ODATANO (network=${NETWORK:-preview}, auth=${ODATANO_AUTH:-basic}, db=$DB_LABEL)"
exec node /app/node_modules/@sap/cds/bin/serve.js srv "$@"
