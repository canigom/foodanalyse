#!/bin/sh
# Container entrypoint.
#
# Runs every time the container starts:
#   1. Sync the Prisma schema with the live Postgres DB.
#      `db push` creates missing tables/columns and is idempotent — safe at
#      every boot. We use it instead of `migrate deploy` because the project
#      has no `prisma/migrations` folder yet (still pre-1.0; schema evolves
#      via `db push` until we cut a stable release and baseline migrations).
#   2. Start the standalone Next.js server.

set -e

echo "[entrypoint] Syncing database schema (prisma db push)..."
node ./node_modules/prisma/build/index.js db push --accept-data-loss --skip-generate

echo "[entrypoint] Starting KochHeute API on $HOSTNAME:$PORT..."
exec node server.js
