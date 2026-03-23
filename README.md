# 🦀 ClawdBack

A purpose-built backup tool for OpenClaw instances — lightweight Node.js web UI + one-command CLI for backing up, transferring, and restoring OpenClaw instances across machines.

---

## What It Does

- **Backup** — SSH into a remote instance and run `openclaw backup create`
- **Transfer** — SCP the archive from remote to `~/backups/` on this machine
- **Restore** — Send an archive to a target VM and run `rehydrate.sh`
- **List backups** — Browse archives with size and date
- **Instance registry** — Track which machines to back up (add/remove/list)
- **View logs** — Tail operation logs from backup/transfer/restore runs

---

## CLI Mode (one-command backup)

```bash
# Backup an instance by ID or name
node server.js --backup <instance-id-or-name>

# List all archives in ~/backups/
node server.js --list-backups
```

The `--backup` command will:
1. Find the instance by ID or name
2. SSH in and run `openclaw backup create`
3. SCP the archive to `~/backups/`
4. Print confirmation with archive path and size
5. Exit (no web server started)

---

## Web UI

Three sections in the dashboard:

- **Instances** — add/remove/list the machines you back up
- **Backup & Transfer** — trigger a backup on any instance, or do a full backup+transfer to this machine
- **Restore** — pick an archive from `~/backups/`, select usernames, run rehydrate.sh

---

## Requirements

- **Node.js 18+**
- `express` (installed via npm)
- SSH key-based access to remote instances
- `openclaw` CLI available in PATH (for local operations)

---

## Setup

```bash
cd ~/.openclaw/workspace/claw-manager

npm install

# Optional: set auth token
export CLAW_MANAGER_TOKEN=your-secret-token

# Start web UI
node server.js

# Or use CLI directly
node server.js --list-backups
node server.js --backup "DO Droplet"
```

Web UI available at `http://192.168.50.84:7788`.

---

## Environment Variables

| Variable              | Default  | Description                                                       |
|-----------------------|----------|-------------------------------------------------------------------|
| `CLAW_MANAGER_TOKEN`  | _(none)_ | Bearer token for API auth. If unset, runs in dev mode (no auth). |
| `PORT`                | `7788`   | Port for the web server.                                          |

> **Security note:** Always set `CLAW_MANAGER_TOKEN` in production. Without it, anyone on the network can access all API endpoints.

---

## Backup Directory

Archives are stored in `~/backups/` (created automatically if it doesn't exist). The restore endpoint validates that `archivePath` is inside this directory.

---

## Running with PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

---

## Security Notes

- Set `CLAW_MANAGER_TOKEN` — without it the API is open to anyone who can reach the port
- Server binds to `192.168.50.84` (local network only) by default
- `archivePath` is validated to prevent path traversal
- Usernames are validated against a safe pattern to prevent command injection
- All frontend output is HTML-escaped to prevent XSS
- Log files are capped at 1MB (auto-rotated)

---

## File Structure

```
claw-manager/
├── server.js            # Express server + frontend + CLI
├── package.json
├── ecosystem.config.js  # PM2 config
├── .gitignore
├── README.md
├── instances.json       # Instance registry (gitignored)
└── logs/                # Operation logs (gitignored)
```
