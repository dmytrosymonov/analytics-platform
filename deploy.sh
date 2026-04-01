#!/bin/bash
set -e
cd /opt/analytics-platform

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
npm install --legacy-peer-deps --include=dev

# Ensure app-local dependencies exist before build and prisma commands.
cd apps/admin && npm install --legacy-peer-deps --include=dev && cd ../..
cd apps/api && npm install --legacy-peer-deps --include=dev && cd ../..

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
