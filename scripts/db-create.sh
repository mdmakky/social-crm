#!/usr/bin/env bash
# Creates an isolated test database with the same roles, grants and migrations as the main one.
# Usage: scripts/db-create.sh <database_name>      then run tests with CRM_DB_NAME=<database_name>
set -euo pipefail
DB="${1:?usage: scripts/db-create.sh <database_name>}"
[[ "$DB" =~ ^[a-z][a-z0-9_]{1,40}$ ]] || { echo "invalid database name"; exit 1; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PSQL="psql -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5436 -U postgres"
export PGPASSWORD=postgres
if ! $PSQL -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
  $PSQL -d postgres -c "CREATE DATABASE $DB"
fi
sed "s/ON DATABASE crm /ON DATABASE $DB /g" "$HERE/packages/db/sql/001_roles_and_probe.sql" | $PSQL -d "$DB" 2>&1 | grep -v NOTICE || true
cd "$HERE/packages/db"
DATABASE_URL_MIGRATOR="postgres://crm_migrator:migrator_dev@127.0.0.1:5436/$DB" pnpm run migrate
echo "ready: CRM_DB_NAME=$DB"
