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
  --exclude="$WORKSPACE/node_modules" \
  --exclude="$WORKSPACE/*/node_modules" \
  --exclude="$WORKSPACE/.git" \
  --exclude="$WORKSPACE/sovs-agents" \
  --exclude="$WORKSPACE/claw-manager/logs" \
  --exclude="$WORKSPACE/claw-manager/instances.json" \
  --exclude="$WORKSPACE/browser-data" \
  --exclude="$WORKSPACE/**/__pycache__" \
  --exclude="$WORKSPACE/**/*.pyc" \
  -C "$HOME" \
  .openclaw/workspace \
  .openclaw/openclaw.json \
  2>/dev/null || true

SIZE=$(du -sh "$ARCHIVE" | cut -f1)
echo "✅ Backup created: $ARCHIVE ($SIZE)"
echo "📋 To transfer: scp ubuntu-openclaw@<this-ip>:$ARCHIVE ~/backups/"
