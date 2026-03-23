# 🦀 ClawdBack

On-demand backup and restore tool for OpenClaw instances. Ephemeral by design — run it when you need it, close it when you're done.

## The Workflow

### On the SOURCE instance (where your agent lives):
```bash
bash scripts/backup.sh
```
Creates a timestamped archive at `~/backups/openclaw-backup-YYYYMMDD-HHMMSS.tar.gz`

### On any machine with ClawdBack:
```bash
git clone git@github.com:ClawBack1/claw-manager.git clawdback
cd clawdback && npm install
node server.js
```
Open http://localhost:7788 (or http://&lt;tailscale-ip&gt;:7788)

### Transfer & Restore:
1. Add your source instance in the UI (or use CLI)
2. Click Transfer — pulls the archive over SCP
3. Select archive → select target instance → Restore
4. Done. Close ClawdBack.

## CLI Mode
```bash
node server.js --list-backups          # list available archives
node server.js --backup <instance-id>  # backup end-to-end via CLI
```

## Requirements
- Node.js 18+
- SSH access to source/target instances (Tailscale recommended)
- Target instance must have OpenClaw installed before restore

## No auth, no persistence
ClawdBack is meant to run locally on a trusted network (Tailscale). No token needed. Run it, use it, close it.
