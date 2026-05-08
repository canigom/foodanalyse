#!/bin/sh
# Container entrypoint.
#
# Runs every time the container starts:
#   1. Apply any pending Prisma migrations to the live Postgres DB.
#      `migrate deploy` is non-interactive and idempotent — safe at every boot.
#   2. Start the standalone Next.js server.

set -e

echo "[entrypoint] Applying database migrations..."
node ./node_modules/prisma/build/index.js migrate deploy

echo "[entrypoint] Starting KochHeute API on $HOSTNAME:$PORT..."
exec node server.js
