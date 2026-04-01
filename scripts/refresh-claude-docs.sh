#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DOC="${1:-$ROOT_DIR/AGENTS.md}"
TARGET_DOC="${2:-$ROOT_DIR/CLAUDE.md}"

if [[ ! -f "$SOURCE_DOC" ]]; then
  echo "Source documentation not found: $SOURCE_DOC" >&2
  exit 1
fi

GIT_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")"
GIT_BRANCH="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
GIT_COMMIT_SHORT="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")"
GIT_COMMIT_DATE="$(git -C "$ROOT_DIR" log -1 --date=iso-strict --format=%cd 2>/dev/null || echo "unknown")"
GENERATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

cat "$SOURCE_DOC" > "$TMP_FILE"

cat >> "$TMP_FILE" <<EOF

---

## Claude Deployment Snapshot

- Generated at (UTC): $GENERATED_AT
- Source doc: $(basename "$SOURCE_DOC")
- Branch: $GIT_BRANCH
- Commit: $GIT_COMMIT_SHORT ($GIT_COMMIT)
- Commit date: $GIT_COMMIT_DATE
- Server repo path: $ROOT_DIR
- Deploy workflow: GitHub Actions -> SSH -> /opt/analytics-platform/deploy.sh
- Post-deploy doc refresh: bash scripts/refresh-claude-docs.sh

## Claude Handoff Notes

- Treat this file as the Claude-ready operational context for the deployed checkout.
- Use it together with the codebase as the primary source of truth.
- If runtime behavior differs from this document, prefer the current code and PM2/process state, then update AGENTS.md so the next deploy refreshes this file.
EOF

mv "$TMP_FILE" "$TARGET_DOC"
echo "Claude documentation refreshed: $TARGET_DOC"
