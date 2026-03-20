#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "🚀 Starting Analytics Platform (dev mode)"

# Check services
if ! brew services list | grep -q "postgresql@16.*started"; then
  echo "Starting PostgreSQL..."
  brew services start postgresql@16
fi
if ! redis-cli ping > /dev/null 2>&1; then
  echo "Starting Redis..."
  brew services start redis
fi

# Load .env
set -a
source "$ROOT/.env"
set +a

# Start API
echo "Starting API on http://localhost:3000 ..."
cd "$ROOT/apps/api"
npx tsx src/index.ts &
API_PID=$!
echo "API PID: $API_PID"

# Wait for API
sleep 5

# Start Admin
echo "Starting Admin Panel on http://localhost:3001 ..."
cd "$ROOT/apps/admin"
npm run dev &
ADMIN_PID=$!
echo "Admin PID: $ADMIN_PID"

echo ""
echo "✅ Platform running:"
echo "   API:         http://localhost:3000"
echo "   Health:      http://localhost:3000/health"
echo "   Admin Panel: http://localhost:3001"
echo ""
echo "   Admin login: admin@analytics.local / admin123"
echo ""
echo "Press Ctrl+C to stop all services."

trap "kill $API_PID $ADMIN_PID 2>/dev/null; echo 'Stopped.'" EXIT
wait
