#!/bin/bash
# backup.sh — Run on the SOURCE instance to create a backup archive
# Usage: bash backup.sh
# Output: ~/backups/openclaw-backup-YYYYMMDD-HHMMSS.tar.gz

set -e

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$HOME/backups"
ARCHIVE="$BACKUP_DIR/openclaw-backup-$TIMESTAMP.tar.gz"
WORKSPACE="$HOME/.openclaw/workspace"
CONFIG="$HOME/.openclaw/openclaw.json"

mkdir -p "$BACKUP_DIR"

echo "🦀 ClawdBack — Creating backup..."
echo "Timestamp: $TIMESTAMP"

tar -czf "$ARCHIVE" \
  --exclude="$HOME/.openclaw/workspace/node_modules" \
  --exclude="$HOME/.openclaw/workspace/*/node_modules" \
  --exclude="$HOME/.openclaw/workspace/.git" \
  --exclude="$HOME/.openclaw/workspace/sovs-agents" \
  --exclude="$HOME/.openclaw/workspace/claw-manager/logs" \
  --exclude="$HOME/.openclaw/workspace/claw-manager/instances.json" \
  --exclude="$HOME/.openclaw/workspace/browser-data" \
  --exclude="$HOME/.openclaw/workspace/**/__pycache__" \
  --exclude="$HOME/.openclaw/workspace/**/*.pyc" \
  -C "$HOME" \
  .openclaw/workspace \
  .openclaw/openclaw.json \
  2>&1
TAR_EXIT=${PIPESTATUS[0]:-$?}
if [[ $TAR_EXIT -ne 0 ]]; then
  echo "❌ tar failed with exit code $TAR_EXIT — archive may be corrupt or incomplete"
  rm -f "$ARCHIVE"
  exit 1
fi

echo "🔍 Verifying archive integrity..."
if ! tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
  echo "❌ Archive verification failed — file is corrupt"
  rm -f "$ARCHIVE"
  exit 1
fi
echo "✅ Archive verified OK"

SIZE=$(du -sh "$ARCHIVE" | cut -f1)
echo "✅ Backup created: $ARCHIVE ($SIZE)"
echo "📋 To transfer: scp $(whoami)@<this-ip>:$ARCHIVE ~/backups/"
