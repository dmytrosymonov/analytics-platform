#!/bin/bash
set -e
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

echo "-> Running seed..."
cd apps/api && npx tsx src/db/seed.ts && cd ../..

echo "-> Building admin panel..."
cd apps/admin && rm -rf .next && npx next build && cd ../..

echo "-> Restarting services..."
pm2 delete analytics-api 2>/dev/null || true
pm2 delete analytics-admin 2>/dev/null || true

pm2 start "npx tsx src/index.ts" \
  --name analytics-api \
  --cwd /opt/analytics-platform/apps/api \
  --max-memory-restart 500M \
  --error /var/log/analytics-api-error.log \
  --output /var/log/analytics-api-out.log

pm2 start "npx next start -p 4001" \
  --name analytics-admin \
  --cwd /opt/analytics-platform/apps/admin \
  --max-memory-restart 500M \
  --error /var/log/analytics-admin-error.log \
  --output /var/log/analytics-admin-out.log

pm2 save
pm2 status

echo "Deploy complete!"
