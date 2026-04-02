#!/bin/bash
set -euo pipefail
cd /opt/analytics-platform

install_deps_with_retry() {
  local target_dir="$1"

  echo "-> Installing dependencies in ${target_dir}..."
  if (cd "$target_dir" && npm install --legacy-peer-deps --include=dev); then
    return 0
  fi

  echo "-> npm install failed in ${target_dir}; cleaning node_modules and retrying once..."
  rm -rf "${target_dir}/node_modules"
  (cd "$target_dir" && npm install --legacy-peer-deps --include=dev)
}

require_file() {
  local path="$1"
  local hint="$2"
  if [ ! -f "$path" ]; then
    echo "ERROR: expected file missing: ${path}"
    echo "Hint: ${hint}"
    exit 1
  fi
}

restart_or_start_pm2() {
  local name="$1"
  local cmd="$2"
  local cwd="$3"
  local err_log="$4"
  local out_log="$5"

  if pm2 describe "$name" >/dev/null 2>&1; then
    echo "-> Restarting PM2 app ${name}..."
    pm2 restart "$name" --update-env
  else
    echo "-> Starting PM2 app ${name}..."
    pm2 start "$cmd" \
      --name "$name" \
      --cwd "$cwd" \
      --max-memory-restart 500M \
      --error "$err_log" \
      --output "$out_log"
  fi
}

if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  STASH_NAME="auto-pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)"
  echo "-> Stashing local server changes: ${STASH_NAME}"
  git stash push -u -m "${STASH_NAME}"
fi

echo "-> Pulling latest code..."
git pull

echo "-> Loading environment..."
set -a && source /opt/analytics-platform/.env && set +a

echo "-> Installing ALL dependencies (including dev)..."
install_deps_with_retry /opt/analytics-platform

# Ensure app-local dependencies exist before build and prisma commands.
install_deps_with_retry /opt/analytics-platform/apps/admin
install_deps_with_retry /opt/analytics-platform/apps/api

echo "-> Running migrations..."
cd apps/api && node /opt/analytics-platform/node_modules/.bin/prisma migrate deploy && node /opt/analytics-platform/node_modules/.bin/prisma generate && cd ../..
require_file /opt/analytics-platform/node_modules/.prisma/client/default.js "Prisma client generation did not produce a runnable client"

echo "-> Running seed..."
cd apps/api && npx tsx src/db/seed.ts && cd ../..

echo "-> Building admin panel..."
cd apps/admin && rm -rf .next && npx next build && cd ../..
require_file /opt/analytics-platform/apps/admin/.next/BUILD_ID "Next.js build finished without producing BUILD_ID"

echo "-> Restarting services..."
restart_or_start_pm2 \
  analytics-api \
  "npx tsx src/index.ts" \
  /opt/analytics-platform/apps/api \
  /var/log/analytics-api-error.log \
  /var/log/analytics-api-out.log

restart_or_start_pm2 \
  analytics-admin \
  "npx next start -p 4001" \
  /opt/analytics-platform/apps/admin \
  /var/log/analytics-admin-error.log \
  /var/log/analytics-admin-out.log

echo "-> Waiting for API health..."
for _ in {1..10}; do
  if curl -fsS http://localhost:4000/health >/dev/null; then
    break
  fi
  sleep 2
done
curl -fsS http://localhost:4000/health >/dev/null

pm2 save
pm2 status

echo "Deploy complete!"
