#!/bin/bash
# backup.sh — Run on the SOURCE instance to create a backup archive
# Usage: bash backup.sh
# Output: ~/backups/openclaw-backup-YYYYMMDD-HHMMSS.tar.gz
#
# Note: target machine must have Node.js 22+ installed for OpenClaw
# Install: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

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
  --exclude="$HOME/.openclaw/agents/main/sessions" \
  --exclude="$HOME/.openclaw/subagents" \
  --exclude="$HOME/.openclaw/logs" \
  -C "$HOME" \
  .openclaw/workspace \
  .openclaw/openclaw.json \
  .openclaw/cron \
  .openclaw/agents/main/agent \
  .openclaw/credentials \
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

# Redact channel tokens (botToken, appToken, token) from openclaw.json in archive
echo "🔐 Redacting channel tokens from backup..."
TMPDIR=$(mktemp -d)
tar -xzf "$ARCHIVE" -C "$TMPDIR" 2>/dev/null

# Find and redact all openclaw.json files
for conf in $(find "$TMPDIR" -name 'openclaw.json' 2>/dev/null); do
  python3 -c "
import json
with open('$conf') as f:
    d = json.load(f)
for ch in d.get('channels', {}).values():
    for key in ['botToken', 'appToken', 'token']:
        if key in ch:
            ch[key] = '__REDACTED__'
with open('$conf', 'w') as f:
    json.dump(d, f, indent=4)
" 2>/dev/null && echo "  ✓ Redacted tokens from $(basename $(dirname $conf))/$(basename $conf)"
done

# Repack the archive
cd "$TMPDIR"
tar -czf "$ARCHIVE" . 2>/dev/null
rm -rf "$TMPDIR"
echo "🔐 Channel tokens redacted from backup"

SIZE=$(du -sh "$ARCHIVE" | cut -f1)
echo "✅ Backup created: $ARCHIVE ($SIZE)"
echo "📋 To transfer: scp $(whoami)@<this-ip>:$ARCHIVE ~/backups/"
