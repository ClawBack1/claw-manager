# 🦀 Claw Manager

OpenClaw instance management dashboard — a lightweight Node.js web UI for managing, monitoring, backing up, and restoring OpenClaw instances across machines.

---

## What It Is

Claw Manager provides a single-page dashboard to:

- **Monitor** multiple OpenClaw instances (status, health checks)
- **Backup** instances via `openclaw backup create`
- **Transfer** backups from remote instances to this machine via SCP
- **Restore** from a backup archive using `rehydrate.sh`
- **View logs** from all operations
- **Inspect cron jobs** on any instance
- **Run health verification** — checks workspace files, gateway, Telegram, crons, etc.

---

## Requirements

- **Node.js 18+**
- `express` (installed via npm)
- SSH access to remote instances (key-based recommended)
- `openclaw` CLI available in PATH (for local operations)

---

## Setup

```bash
# Clone or copy this directory
cd ~/.openclaw/workspace/claw-manager

# Install dependencies
npm install

# (Optional) Set environment variables
export CLAW_MANAGER_TOKEN=your-secret-token
export PORT=7788

# Start the server
node server.js
```

The dashboard will be available at `http://192.168.50.84:7788`.

---

## Environment Variables

| Variable               | Default         | Description                                               |
|------------------------|-----------------|-----------------------------------------------------------|
| `CLAW_MANAGER_TOKEN`   | _(none)_        | Bearer token for API auth. If unset, runs in dev mode (no auth). |
| `PORT`                 | `7788`          | Port to listen on.                                        |
| `NODE_ENV`             | _(none)_        | Set to `production` for PM2 deployments.                  |

> **Security note:** Always set `CLAW_MANAGER_TOKEN` in production. Without it, anyone on the network can access all API endpoints.

---

## Adding Instances

1. Open the dashboard in your browser
2. Fill in the **Add Instance** form:
   - **Name** — friendly label (e.g. "DO Droplet")
   - **Host** — IP or hostname (use `localhost` for local)
   - **SSH User** — the remote username
   - **SSH Key** — path to private key (e.g. `~/.ssh/do_key`), leave blank for default
3. Click **+ Add Instance**

Instances are saved to `instances.json` in the project directory.

---

## Running with PM2

```bash
# Install PM2 globally (if not already)
npm install -g pm2

# Start via ecosystem file
pm2 start ecosystem.config.js

# Save PM2 process list (auto-restart on reboot)
pm2 save
pm2 startup
```

---

## Security Notes

- **Set `CLAW_MANAGER_TOKEN`** — without it, the API is wide open to anyone who can reach the port.
- The server binds to `192.168.50.84` (local network) by default, not `0.0.0.0`.
- `instances.json` contains hostnames and SSH key paths — keep it out of version control (it's in `.gitignore`).
- The restore endpoint validates `archivePath` to prevent path traversal.
- Username fields are validated against a safe pattern to prevent command injection.
- All user-supplied data rendered in the frontend is HTML-escaped to prevent XSS.
- Log files are capped at 1MB (auto-rotated by truncation).

---

## File Structure

```
claw-manager/
├── server.js          # Express server + single-file frontend
├── package.json
├── ecosystem.config.js  # PM2 config
├── .gitignore
├── README.md
├── instances.json     # Instance registry (gitignored)
└── logs/              # Operation logs (gitignored)
```
