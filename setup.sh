#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  NRT Finance API — Setup Script
#  Run once on a fresh machine to bootstrap the DB and .env.
#
#  Usage:
#    chmod +x setup.sh
#    ./setup.sh [--db-host HOST] [--db-user USER] [--db-pass PASS]
# ══════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-nrt_finance}"
DB_USER="${DB_USER:-nrt_user}"
DB_PASSWORD="${DB_PASSWORD:-}"

# Parse CLI flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-host) DB_HOST="$2";     shift 2 ;;
    --db-port) DB_PORT="$2";     shift 2 ;;
    --db-name) DB_NAME="$2";     shift 2 ;;
    --db-user) DB_USER="$2";     shift 2 ;;
    --db-pass) DB_PASSWORD="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  NRT Finance API — Setup                 ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Node version check ────────────────────────────────────────────
NODE_VER=$(node -e "process.exit(Number(process.versions.node.split('.')[0]) < 18 ? 1 : 0)" 2>&1) || {
  echo "❌  Node.js 18+ is required. Install it from https://nodejs.org"
  exit 1
}
echo "✅  Node.js $(node --version)"

# ── npm install ───────────────────────────────────────────────────
echo ""
echo "📦  Installing npm dependencies..."
npm ci --silent
echo "✅  Dependencies installed"

# ── .env setup ───────────────────────────────────────────────────
if [[ -f .env ]]; then
  echo ""
  echo "⚠️  .env already exists — skipping (delete it and re-run to regenerate)"
else
  echo ""
  echo "🔑  Generating .env with fresh JWT secrets..."

  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  REFRESH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

  if [[ -z "$DB_PASSWORD" ]]; then
    read -rsp "  Enter PostgreSQL password for user '$DB_USER': " DB_PASSWORD
    echo ""
  fi

  cat > .env << ENVEOF
# ── Server ────────────────────────────────────────────────────────
PORT=3000
NODE_ENV=development

# ── PostgreSQL ────────────────────────────────────────────────────
DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT}
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_SSL=false

# ── JWT ───────────────────────────────────────────────────────────
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=15m
REFRESH_SECRET=${REFRESH_SECRET}
REFRESH_EXPIRES_IN=7d

# ── CORS ──────────────────────────────────────────────────────────
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3001

# ── Rate Limiting ─────────────────────────────────────────────────
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=300
AUTH_RATE_LIMIT_MAX=20
ENVEOF

  echo "✅  .env created"
fi

# ── PostgreSQL: create role + database if they don't exist ────────
echo ""
echo "🐘  Checking PostgreSQL..."

PG_OPTS="-h ${DB_HOST} -p ${DB_PORT}"

# Try to connect as postgres superuser to create role/db
SUPERUSER=""
for SU in postgres root ubuntu; do
  if psql $PG_OPTS -U "$SU" -c "SELECT 1;" &>/dev/null 2>&1; then
    SUPERUSER="$SU"
    break
  fi
done

if [[ -z "$SUPERUSER" ]]; then
  echo "⚠️  Could not connect as a PostgreSQL superuser."
  echo "    Create the DB and user manually, then re-run:"
  echo ""
  echo "    CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}' CREATEDB;"
  echo "    CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
  echo ""
else
  psql $PG_OPTS -U "$SUPERUSER" -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
    psql $PG_OPTS -U "$SUPERUSER" -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}' CREATEDB;" && \
    echo "✅  Role '${DB_USER}' ready"

  psql $PG_OPTS -U "$SUPERUSER" -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
    psql $PG_OPTS -U "$SUPERUSER" -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};" && \
    echo "✅  Database '${DB_NAME}' ready"
fi

# ── Apply schema ──────────────────────────────────────────────────
echo ""
echo "📐  Applying schema..."
PGPASSWORD="${DB_PASSWORD}" psql $PG_OPTS -U "${DB_USER}" -d "${DB_NAME}" -f schema.sql
echo "✅  Schema applied (tables, indexes, seed data)"

# ── Health check ──────────────────────────────────────────────────
echo ""
echo "🔍  Testing database connection..."
PGPASSWORD="${DB_PASSWORD}" psql $PG_OPTS -U "${DB_USER}" -d "${DB_NAME}" -c "SELECT COUNT(*) AS accounts FROM accounts;" -t | xargs | \
  (read N; echo "✅  DB connected — ${N} accounts in chart of accounts")

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Start the server:"
echo "    npm run dev     ← development (auto-reload)"
echo "    npm start       ← production"
echo ""
echo "  Health check:     curl http://localhost:3000/health"
echo "  Default login:    admin / Admin@123"
echo "  ⚠️  Change the admin password immediately after first login."
echo "══════════════════════════════════════════════════════════"
echo ""
