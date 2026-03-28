# 🦀 ClawdBack

On-demand backup and restore tool for OpenClaw instances. Ephemeral by design — run it when you need it, close it when you're done.

## The Workflow

### Step 1 — Start ClawdBack on any machine:
```bash
git clone git@github.com:ClawBack1/claw-manager.git clawdback
cd clawdback && npm install
node server.js
```
Open http://localhost:7788

### Step 2 — Add your source instance:
In the **Instances** tab: add the machine where your agent lives (host IP/Tailscale, SSH user, key path).

### Step 3 — Create backup + transfer:
In the **Backup & Transfer** tab:
1. Select your source instance
2. Click **Create Backup** — runs `openclaw backup create` on the remote, creates a `.tar.gz` archive
3. Click **Transfer** — SCPs the archive to `~/backups/` on this machine (integrity verified automatically)

### Step 4 — Restore (disaster recovery):
In the **Restore** tab:
1. Select the archive to restore from
2. Enter the old username (from the backup) and new username (on this machine)
3. Click **Restore** — extracts the archive, rewrites paths, restarts the gateway
4. Your agent comes back with full memory, identity, scripts, and crons intact

### Step 5 — Done. Close ClawdBack:
```bash
Ctrl+C
```

## After Restore — Required Steps

1. **Channel tokens are redacted** — Telegram/Slack bot tokens are stripped from backups for security. Reconfigure them in `~/.openclaw/openclaw.json`:
   ```json
   "channels": {
     "telegram": { "botToken": "YOUR_NEW_TOKEN" },
     "slack": { "botToken": "YOUR_NEW_TOKEN", "appToken": "YOUR_NEW_APP_TOKEN" }
   }
   ```

2. **Re-pair your user ID** — If you're using a new bot token, pair your user ID with it:
   ```bash
   openclaw config telegram authorize <your-user-id>
   ```

3. **Session history is cleared** — The agent starts fresh. Your workspace, memory files, crons, and identity are preserved, but conversation history from the source machine is not transferred.

4. **Verify crons** — Run `openclaw cron list` to confirm your scheduled jobs survived.

## Important Notes

- **Restore runs locally** — ClawdBack restores the backup onto the machine it's running on, not a remote target
- **Archive integrity** — transfers are verified automatically. If verification fails, the archive is rejected
- **Disk space** — ClawdBack checks available space before transferring
- **Gateway restart** — restoring will restart the OpenClaw gateway (drops active connections briefly)
- **Node.js 22+ required** — The target machine must have Node.js 22 or later installed

## CLI Mode
```bash
node server.js --list-backups          # list archives in ~/backups/
node server.js --backup <instance-id>  # full backup end-to-end (no UI)
```

## Source-side backup script
`scripts/backup.sh` is an alternative standalone script you can run directly on the source machine (without ClawdBack running). Useful for cron jobs or manual backups without a UI:
```bash
bash /path/to/clawdback/scripts/backup.sh
```
Output: `~/backups/openclaw-backup-YYYYMMDD-HHMMSS.tar.gz`

## Requirements
- Node.js 18+
- SSH access to source instance (Tailscale recommended)
- OpenClaw installed on the target machine before restore

## No Auth, No Persistence
ClawdBack is for trusted networks (Tailscale). No token needed. Run it, use it, close it.
