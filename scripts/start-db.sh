#!/usr/bin/env bash
# Start a local PostgreSQL using the embedded binaries shipped via npm
# (for environments with no system PostgreSQL and no Docker, e.g. the Arena sandbox).
#
# Usage:  ./scripts/start-db.sh
# Env:    PGDATA (default ./.pgdata)   PORT (default 5432)
set -euo pipefail
cd "$(dirname "$0")/.."

NATIVE="node_modules/@embedded-postgres/linux-x64/native"
if [ ! -x "$NATIVE/bin/postgres" ]; then
  echo "embedded postgres binaries not found — run: npm install" >&2
  exit 1
fi

export LD_LIBRARY_PATH="$PWD/$NATIVE/lib"
PGDATA="${PGDATA:-$PWD/.pgdata}"
PORT="${PORT:-5432}"

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "Initializing PostgreSQL data directory at $PGDATA ..."
  mkdir -p "$PGDATA"
  "$PWD/$NATIVE/bin/initdb" -D "$PGDATA" -U postgres --auth=trust -E UTF8 --no-locale
fi

echo "Starting PostgreSQL on 127.0.0.1:$PORT ..."
exec "$PWD/$NATIVE/bin/postgres" -D "$PGDATA" -p "$PORT" -k /tmp
