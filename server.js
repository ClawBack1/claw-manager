#!/usr/bin/env node
// ============================================================
// Claw Manager — OpenClaw instance management dashboard
// Usage: node server.js [port]
// Default port: 7788
// ============================================================

const express = require('express');
const { execSync, exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || process.argv[2] || 7788;
const CLAW_MANAGER_TOKEN = process.env.CLAW_MANAGER_TOKEN || null;
const INSTANCES_FILE = path.join(__dirname, 'instances.json');
const SCRIPTS_DIR = path.join(os.homedir(), '.openclaw/workspace/scripts');
const BACKUP_DIR = os.homedir();
const LOG_DIR = path.join(__dirname, 'logs');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// In-memory cache for verification results, keyed by instance ID
const verificationCache = new Map();

const app = express();
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────
if (!CLAW_MANAGER_TOKEN) {
  console.warn('⚠️  CLAW_MANAGER_TOKEN not set — running in dev mode (no auth)');
}

app.use('/api', (req, res, next) => {
  if (!CLAW_MANAGER_TOKEN) return next(); // dev mode — no token set
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== CLAW_MANAGER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── Helpers ──────────────────────────────────────────────────

function loadInstances() {
  try {
    const raw = fs.readFileSync(INSTANCES_FILE, 'utf8');
    try {
      return JSON.parse(raw).instances || [];
    } catch (parseErr) {
      console.error('ERROR: instances.json is corrupt (JSON parse failed):', parseErr.message);
      throw new Error('instances.json is corrupt — refusing to silently return empty list. Fix or delete the file.');
    }
  } catch (readErr) {
    if (readErr.code === 'ENOENT') return []; // file doesn't exist yet — that's fine
    throw readErr; // re-throw corrupt JSON or other read errors
  }
}

function saveInstances(instances) {
  fs.writeFileSync(INSTANCES_FILE, JSON.stringify({ instances }, null, 2));
}

function expandHome(p) {
  if (!p) return p;
  return p.replace(/^~/, os.homedir());
}

function sshCmd(instance, cmd) {
  if (instance.host === 'localhost' || instance.host === '127.0.0.1') {
    return cmd;
  }
  const key = instance.ssh_key ? `-i ${expandHome(instance.ssh_key)}` : '';
  return `ssh -o StrictHostKeyChecking=no ${key} ${instance.user}@${instance.host} "${cmd.replace(/"/g, '\\"')}"`;
}

const LOG_MAX_BYTES = 1 * 1024 * 1024; // 1MB

function rotateLogIfNeeded(logFile) {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX_BYTES) {
      fs.truncateSync(logFile, 0);
    }
  } catch (e) { /* ignore rotation errors */ }
}

function runAsync(cmd, logFile) {
  return new Promise((resolve) => {
    rotateLogIfNeeded(logFile);
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    const ts = new Date().toISOString();
    log.write(`\n=== ${ts} ===\n$ ${cmd}\n`);

    const proc = exec(cmd, { shell: '/bin/bash' });
    let stdout = '', stderr = '';

    proc.stdout.on('data', d => { stdout += d; log.write(d); });
    proc.stderr.on('data', d => { stderr += d; log.write('[ERR] ' + d); });

    // P0-3 FIX: handle spawn errors to avoid unhandled EventEmitter exceptions
    proc.on('error', err => {
      const msg = `[spawn error] ${err.message}\n`;
      stderr += msg;
      log.write(msg);
      log.end();
      resolve({ code: 1, stdout, stderr });
    });

    proc.on('close', code => {
      log.write(`\n[exit ${code}]\n`);
      log.end();
      resolve({ code, stdout, stderr });
    });
  });
}

// ── API Routes ───────────────────────────────────────────────

// GET /api/instances — list all instances
app.get('/api/instances', (req, res) => {
  res.json(loadInstances());
});

// POST /api/instances — add instance
app.post('/api/instances', (req, res) => {
  const instances = loadInstances();
  const inst = { id: Date.now().toString(), ...req.body };
  instances.push(inst);
  saveInstances(instances);
  res.json(inst);
});

// DELETE /api/instances/:id
app.delete('/api/instances/:id', (req, res) => {
  const instances = loadInstances().filter(i => i.id !== req.params.id);
  saveInstances(instances);
  res.json({ ok: true });
});

// GET /api/instances/:id/status — ping + check openclaw status
app.get('/api/instances/:id/status', async (req, res) => {
  const inst = loadInstances().find(i => i.id === req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });

  try {
    const cmd = sshCmd(inst, 'openclaw status --json 2>/dev/null || openclaw status 2>&1 | head -20');
    const result = await runAsync(cmd, path.join(LOG_DIR, `status_${inst.id}.log`));
    res.json({ online: result.code === 0, output: result.stdout || result.stderr });
  } catch (e) {
    res.json({ online: false, output: e.message });
  }
});

// GET /api/instances/:id/crons — list cron jobs
app.get('/api/instances/:id/crons', async (req, res) => {
  const inst = loadInstances().find(i => i.id === req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });

  const cmd = sshCmd(inst, 'openclaw cron list 2>&1');
  const result = await runAsync(cmd, path.join(LOG_DIR, `crons_${inst.id}.log`));
  res.json({ output: result.stdout || result.stderr });
});

// ── Verification helpers ─────────────────────────────────────

async function runVerification(inst) {
  const isLocal = inst.host === 'localhost' || inst.host === '127.0.0.1';
  const home = inst.openclaw_state
    ? inst.openclaw_state.replace(/\/.openclaw$/, '')
    : `/home/${inst.user}`;
  const workspace = `${home}/.openclaw/workspace`;

  async function run(cmd) {
    const fullCmd = isLocal ? cmd : sshCmd(inst, cmd);
    return new Promise(resolve => {
      exec(fullCmd, { shell: '/bin/bash', timeout: 15000 }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
      });
    });
  }

  const checks = [];

  // 1. Workspace files
  const wsFiles = ['MEMORY.md', 'SOUL.md', 'AGENTS.md', 'USER.md', 'CREDS.md', 'MACRO_BRIEF.md', 'HEARTBEAT.md', 'IDENTITY.md'];
  for (const f of wsFiles) {
    const r = await run(`test -f "${workspace}/${f}" && wc -c < "${workspace}/${f}" || echo MISSING`);
    const out = r.stdout.trim();
    if (out === 'MISSING' || r.code !== 0) {
      checks.push({ name: `File: ${f}`, status: 'error', detail: 'Missing' });
    } else {
      const bytes = parseInt(out, 10);
      if (bytes < 10) {
        checks.push({ name: `File: ${f}`, status: 'warn', detail: `Present but tiny (${bytes} bytes)` });
      } else {
        checks.push({ name: `File: ${f}`, status: 'ok', detail: `${bytes} bytes` });
      }
    }
  }

  // 2. Scripts dir
  const scriptsR = await run(`ls "${workspace}/scripts/"*.py 2>/dev/null | wc -l`);
  const pyCount = parseInt(scriptsR.stdout.trim(), 10) || 0;
  if (pyCount === 0) {
    const dirR = await run(`test -d "${workspace}/scripts" && echo exists || echo missing`);
    if (dirR.stdout.trim() === 'missing') {
      checks.push({ name: 'Scripts dir', status: 'error', detail: 'scripts/ directory missing' });
    } else {
      checks.push({ name: 'Scripts dir', status: 'warn', detail: 'scripts/ exists but no .py files' });
    }
  } else {
    checks.push({ name: 'Scripts dir', status: 'ok', detail: `${pyCount} .py files` });
  }

  // 3. Proton session
  const protonR = await run(`test -f "${home}/.proton-session" && echo exists || echo missing`);
  const protonExists = protonR.stdout.trim() === 'exists';
  checks.push({ name: 'Proton session', status: protonExists ? 'ok' : 'warn', detail: protonExists ? 'Present' : '.proton-session not found' });

  // 4. Cron jobs
  const cronR = await run('openclaw cron list 2>&1');
  const cronLines = cronR.stdout.split('\n').filter(l => l.match(/isolated|main/)).length;
  if (cronLines === 0) {
    checks.push({ name: 'Cron jobs', status: 'warn', detail: 'No cron jobs found' });
  } else {
    checks.push({ name: 'Cron jobs', status: 'ok', detail: `${cronLines} jobs configured` });
  }

  // 5. Gateway status
  const gwR = await run('openclaw status 2>&1 | head -10');
  const gwRunning = gwR.stdout.toLowerCase().includes('running') || gwR.code === 0;
  checks.push({ name: 'Gateway', status: gwRunning ? 'ok' : 'error', detail: gwRunning ? 'Running' : 'Not running or unreachable' });

  // 6. Telegram channel configured
  const tgR = await run(`cat "${home}/.openclaw/openclaw.json" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); plugins=d.get('plugins',{}); entries=plugins.get('entries',{}); tg=[k for k,v in entries.items() if 'telegram' in k.lower() or (isinstance(v,dict) and 'telegram' in str(v).lower())]; print('found' if tg else 'none')" 2>/dev/null || echo none`);
  const tgFound = tgR.stdout.trim() === 'found';
  checks.push({ name: 'Telegram channel', status: tgFound ? 'ok' : 'warn', detail: tgFound ? 'Configured' : 'Not found in openclaw.json' });

  const passing = checks.filter(c => c.status === 'ok').length;
  const result = { instanceId: inst.id, instanceName: inst.name, checks, passing, total: checks.length, timestamp: new Date().toISOString() };
  verificationCache.set(inst.id, result);
  return result;
}

// GET /api/instances/:id/verify
app.get('/api/instances/:id/verify', async (req, res) => {
  const inst = loadInstances().find(i => i.id === req.params.id);
  if (!inst) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await runVerification(inst);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/instances/:id/verify/cached
app.get('/api/instances/:id/verify/cached', (req, res) => {
  const cached = verificationCache.get(req.params.id);
  if (!cached) return res.json(null);
  res.json(cached);
});

// POST /api/backup — create backup on an instance
app.post('/api/backup', async (req, res) => {
  const { instanceId } = req.body;
  const inst = loadInstances().find(i => i.id === instanceId);
  if (!inst) return res.status(404).json({ error: 'Not found' });

  const logFile = path.join(LOG_DIR, `backup_${inst.id}_${Date.now()}.log`);
  const cmd = sshCmd(inst, 'openclaw gateway stop || true; sleep 1; openclaw backup create --verify; openclaw gateway restart || true');

  res.json({ started: true, logFile });

  // Run in background — P0-4 FIX: catch unhandled rejection
  runAsync(cmd, logFile).then(result => {
    console.log(`Backup complete for ${inst.name}: exit ${result.code}`);
  }).catch(err => console.error(`Backup async error for ${inst.name}:`, err));
});

// POST /api/transfer — backup source instance and transfer to this machine
app.post('/api/transfer', async (req, res) => {
  const { sourceId, destId } = req.body;
  const source = loadInstances().find(i => i.id === sourceId);
  const dest = loadInstances().find(i => i.id === destId) || loadInstances().find(i => i.host === 'localhost');
  if (!source) return res.status(404).json({ error: 'Source not found' });

  const logFile = path.join(LOG_DIR, `transfer_${sourceId}_${Date.now()}.log`);
  const log = (msg) => { rotateLogIfNeeded(logFile); fs.appendFileSync(logFile, msg + '\n'); };

  res.json({ started: true, logFile: path.basename(logFile) });

  // P0-4 FIX: wrap all post-response async work in try/catch to avoid unhandled rejections
  try {
    // Step 1: Create backup on source
    log('=== Step 1: Creating backup on source ===');
    const backupCmd = sshCmd(source,
      'openclaw gateway stop || true; sleep 1; openclaw backup create --verify 2>&1'
    );
    const backupResult = await runAsync(backupCmd, logFile);

    // Extract archive path from output
    const match = backupResult.stdout.match(/Backup archive: (.+\.tar\.gz)/);
    if (!match) {
      log('ERROR: Could not find backup archive path in output');
      log(backupResult.stdout);
      log(backupResult.stderr);
      return;
    }

    const remotePath = match[1].trim();
    const filename = path.basename(remotePath);
    const localPath = path.join(BACKUP_DIR, filename);

    log(`\n=== Step 2: Transferring ${filename} ===`);

    // Step 2: SCP to this machine
    let scpCmd;
    if (source.host === 'localhost') {
      scpCmd = `cp "${remotePath}" "${localPath}"`;
    } else {
      const key = source.ssh_key ? `-i ${expandHome(source.ssh_key)}` : '';
      scpCmd = `scp -o StrictHostKeyChecking=no ${key} ${source.user}@${source.host}:"${remotePath}" "${localPath}"`;
    }

    const scpResult = await runAsync(scpCmd, logFile);
    if (scpResult.code !== 0) {
      log('ERROR: SCP failed');
      return;
    }
    log(`Transfer complete: ${localPath}`);

    // Restart source gateway
    const restartCmd = sshCmd(source, 'openclaw gateway restart || true');
    await runAsync(restartCmd, logFile);

    log('\n=== Transfer complete ===');
    log(`Archive ready at: ${localPath}`);
    log(`To restore: bash ${SCRIPTS_DIR}/rehydrate.sh "${localPath}" ${source.user} ${dest ? dest.user : os.userInfo().username}`);

    // If dest is localhost, optionally surface a note about running verification after restore
    const localInstForVerify = loadInstances().find(i => i.host === 'localhost' || i.host === '127.0.0.1');
    if (localInstForVerify) {
      log('\nTip: After restoring, use /api/instances/' + localInstForVerify.id + '/verify to check restore health.');
    }
  } catch (err) {
    console.error('Transfer async error:', err);
    log(`\nFATAL ERROR: ${err.message}`);
  }
});

// POST /api/restore — run rehydrate.sh on this machine
// P0-2 FIX: Validate oldUser/newUser against safe username pattern; validate archivePath is inside BACKUP_DIR
const SAFE_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

app.post('/api/restore', async (req, res) => {
  const { archivePath, oldUser, newUser } = req.body;

  // Validate username fields to prevent command injection
  const resolvedOldUser = oldUser || 'openclaw';
  const resolvedNewUser = newUser || os.userInfo().username;
  if (!SAFE_USERNAME_RE.test(resolvedOldUser)) {
    return res.status(400).json({ error: `Invalid oldUser: ${resolvedOldUser}` });
  }
  if (!SAFE_USERNAME_RE.test(resolvedNewUser)) {
    return res.status(400).json({ error: `Invalid newUser: ${resolvedNewUser}` });
  }

  // Validate archivePath: must be a string, end with .tar.gz, and live inside BACKUP_DIR
  if (!archivePath || typeof archivePath !== 'string') {
    return res.status(400).json({ error: 'archivePath is required' });
  }
  const resolvedArchive = path.resolve(archivePath);
  if (!resolvedArchive.startsWith(BACKUP_DIR + path.sep) && resolvedArchive !== BACKUP_DIR) {
    return res.status(400).json({ error: 'archivePath must be inside the backup directory' });
  }
  if (!resolvedArchive.endsWith('.tar.gz')) {
    return res.status(400).json({ error: 'archivePath must be a .tar.gz file' });
  }
  if (!fs.existsSync(resolvedArchive)) {
    return res.status(400).json({ error: `Archive not found: ${resolvedArchive}` });
  }

  const rehydrateScript = path.join(SCRIPTS_DIR, 'rehydrate.sh');
  if (!fs.existsSync(rehydrateScript)) {
    return res.status(500).json({ error: 'rehydrate.sh not found in scripts/' });
  }

  const logFile = path.join(LOG_DIR, `restore_${Date.now()}.log`);
  // Safe: all three arguments are validated above
  const cmd = `bash "${rehydrateScript}" "${resolvedArchive}" "${resolvedOldUser}" "${resolvedNewUser}"`;

  // Find localhost instance for post-restore verification
  const localInst = loadInstances().find(i => i.host === 'localhost' || i.host === '127.0.0.1');

  res.json({ started: true, logFile: path.basename(logFile) });
  // P0-4 FIX: catch unhandled rejection on fire-and-forget chain
  runAsync(cmd, logFile).then(async r => {
    console.log(`Restore done: exit ${r.code}`);
    if (localInst) {
      try {
        fs.appendFileSync(logFile, '\n=== Post-Restore Verification ===\n');
        const vr = await runVerification(localInst);
        const missing = vr.checks.filter(c => c.status !== 'ok').map(c => c.name);
        fs.appendFileSync(logFile, `Restore health: ${vr.passing}/${vr.total} checks passing.\n`);
        if (missing.length) {
          fs.appendFileSync(logFile, `Missing/Warn: ${missing.join(', ')}\n`);
        } else {
          fs.appendFileSync(logFile, 'All checks passed ✓\n');
        }
      } catch (e) {
        fs.appendFileSync(logFile, `Verification error: ${e.message}\n`);
      }
    }
  }).catch(err => console.error('Restore async error:', err));
});

// GET /api/backups — list backup archives on this machine
app.get('/api/backups', (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('-openclaw-backup.tar.gz'))
      .map(f => {
        const full = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(full);
        return { name: f, path: full, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// GET /api/logs/:file — tail a log file
// P0-1 FIX: Use path.basename() to prevent path traversal; verify resolved path is inside LOG_DIR
app.get('/api/logs/:file', (req, res) => {
  const safeName = path.basename(req.params.file);
  const logFile = path.join(LOG_DIR, safeName);
  // Double-check resolved path is still inside LOG_DIR (defence-in-depth)
  if (!logFile.startsWith(LOG_DIR + path.sep) && logFile !== LOG_DIR) {
    return res.status(400).json({ error: 'Invalid log file path' });
  }
  if (!fs.existsSync(logFile)) return res.status(404).json({ error: 'Not found' });
  const content = fs.readFileSync(logFile, 'utf8');
  res.type('text/plain').send(content);
});

// GET /api/logs — list log files
app.get('/api/logs', (req, res) => {
  const files = fs.readdirSync(LOG_DIR)
    .filter(f => f.endsWith('.log'))
    .map(f => {
      const stat = fs.statSync(path.join(LOG_DIR, f));
      return { name: f, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 20);
  res.json(files);
});

// ── Frontend ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(HTML);
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, '192.168.50.84', () => {
  console.log(`🦀 Claw Manager running at http://192.168.50.84:${PORT}`);
});

// ── HTML (single-file frontend) ──────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🦀 Claw Manager</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d0d0d; color: #e0e0e0; min-height: 100vh; }
  header { background: #1a1a1a; border-bottom: 2px solid #c0392b; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 1.4rem; color: #fff; }
  header span { color: #888; font-size: 0.85rem; }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 20px; }
  .card h2 { font-size: 1rem; color: #ccc; margin-bottom: 16px; border-bottom: 1px solid #2a2a2a; padding-bottom: 10px; }
  .instance { background: #111; border: 1px solid #2a2a2a; border-radius: 6px; padding: 14px; margin-bottom: 10px; }
  .instance-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .instance-name { font-weight: 600; color: #fff; }
  .instance-host { font-size: 0.8rem; color: #666; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; }
  .badge-green { background: #1a4a1a; color: #4caf50; }
  .badge-red { background: #4a1a1a; color: #f44336; }
  .badge-gray { background: #2a2a2a; color: #888; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border: none; border-radius: 5px; cursor: pointer; font-size: 0.85rem; font-weight: 500; transition: opacity 0.2s; }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: #c0392b; color: #fff; }
  .btn-secondary { background: #2a2a2a; color: #ccc; }
  .btn-success { background: #1e5a1e; color: #4caf50; }
  .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .backup-list { list-style: none; }
  .backup-list li { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: #111; border-radius: 5px; margin-bottom: 6px; font-size: 0.85rem; }
  .backup-name { color: #ccc; font-family: monospace; font-size: 0.8rem; }
  .backup-size { color: #888; margin-left: 8px; }
  .log-area { background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 5px; padding: 12px; font-family: monospace; font-size: 0.78rem; color: #aaa; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; margin-top: 12px; }
  .log-area.hidden { display: none; }
  select, input { background: #111; border: 1px solid #333; border-radius: 5px; color: #e0e0e0; padding: 7px 10px; font-size: 0.85rem; width: 100%; margin-bottom: 8px; }
  .section-title { font-size: 0.75rem; color: #666; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #444; border-top-color: #c0392b; border-radius: 50%; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status-row { font-size: 0.8rem; color: #888; margin-top: 6px; }
  .full-width { grid-column: 1 / -1; }
  .check-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; background: #111; border-radius: 5px; margin-bottom: 5px; font-size: 0.85rem; }
  .check-name { flex: 1; color: #ccc; }
  .check-detail { color: #666; font-size: 0.8rem; flex: 2; }
  .badge-ok { background: #1a4a1a; color: #4caf50; }
  .badge-warn { background: #4a3a00; color: #ffc107; }
  .badge-error { background: #4a1a1a; color: #f44336; }
</style>
</head>
<body>
<header>
  <span style="font-size:1.6rem">🦀</span>
  <h1>Claw Manager</h1>
  <span>OpenClaw Instance Manager</span>
</header>
<div class="container">
  <div class="grid">

    <!-- Instances -->
    <div class="card">
      <h2>🖥️ Instances</h2>
      <div id="instances-list">Loading...</div>
      <div style="margin-top:16px; border-top:1px solid #2a2a2a; padding-top:14px;">
        <div class="section-title">Add Instance</div>
        <input id="add-name" placeholder="Name (e.g. DO Droplet)" />
        <input id="add-host" placeholder="Host (e.g. 64.23.173.242 or localhost)" />
        <input id="add-user" placeholder="SSH user (e.g. openclaw)" />
        <input id="add-key" placeholder="SSH key path (e.g. ~/.ssh/do_key)" />
        <button class="btn btn-primary" onclick="addInstance()">+ Add Instance</button>
      </div>
    </div>

    <!-- Backup & Transfer -->
    <div class="card">
      <h2>💾 Backup & Transfer</h2>
      <div class="section-title">Create Backup</div>
      <select id="backup-source"></select>
      <button class="btn btn-primary" onclick="createBackup()">▶ Create Backup</button>

      <div style="margin-top:16px; border-top:1px solid #2a2a2a; padding-top:14px;">
        <div class="section-title">Transfer (Backup Source → This Machine)</div>
        <select id="transfer-source"></select>
        <button class="btn btn-success" onclick="transferBackup()">⬇ Backup + Transfer Here</button>
      </div>

      <div id="backup-log" class="log-area hidden"></div>
    </div>

    <!-- Restore -->
    <div class="card">
      <h2>🔄 Restore</h2>
      <div class="section-title">Available Backups (this machine)</div>
      <ul class="backup-list" id="backup-files">Loading...</ul>

      <div style="margin-top:14px; border-top:1px solid #2a2a2a; padding-top:14px;">
        <div class="section-title">Restore From</div>
        <select id="restore-backup"></select>
        <input id="restore-old-user" placeholder="Old username (on source machine)" value="openclaw" />
        <input id="restore-new-user" placeholder="New username (this machine)" value="ubuntu-openclaw" />
        <button class="btn btn-primary" onclick="doRestore()">🔄 Restore Now</button>
        <p style="font-size:0.75rem; color:#666; margin-top:8px;">⚠️ Gateway will restart. Chat will drop briefly.</p>
      </div>

      <div id="restore-log" class="log-area hidden"></div>
    </div>

    <!-- Log Viewer -->
    <div class="card">
      <h2>📋 Logs</h2>
      <select id="log-select" onchange="loadLog()">
        <option value="">— select a log —</option>
      </select>
      <div id="log-content" class="log-area hidden"></div>
    </div>

    <!-- Cron Jobs (full width) -->
    <div class="card full-width">
      <h2>⏰ Cron Jobs</h2>
      <select id="cron-instance" style="max-width:300px; display:inline-block; margin-right:8px;"></select>
      <button class="btn btn-secondary" onclick="loadCrons()">Refresh</button>
      <div id="cron-output" class="log-area hidden" style="margin-top:12px; max-height:400px;"></div>
    </div>

    <!-- Instance Health (full width) -->
    <div class="card full-width">
      <h2>🏥 Instance Health</h2>
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:14px;">
        <select id="health-instance" style="max-width:300px; display:inline-block; margin-bottom:0;" onchange="loadCachedHealth()"></select>
        <button class="btn btn-primary" onclick="runVerification()" id="verify-btn">▶ Run Verification</button>
        <span id="health-last-verified" style="font-size:0.78rem; color:#666;"></span>
      </div>
      <div id="health-score" style="margin-bottom:12px; font-size:0.9rem; color:#aaa;"></div>
      <div id="health-checks"></div>
    </div>

  </div>
</div>

<script>
const api = (path, opts) => fetch('/api' + path, opts).then(r => r.json());
const apiText = (path) => fetch('/api' + path).then(r => r.text());

function htmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let instances = [];

async function loadInstances() {
  instances = await api('/instances');
  renderInstances();
  populateSelects();
  loadBackupFiles();
  loadLogs();
}

function renderInstances() {
  const el = document.getElementById('instances-list');
  if (!instances.length) { el.innerHTML = '<p style="color:#666;font-size:0.85rem">No instances configured.</p>'; return; }
  el.innerHTML = instances.map(inst => \`
    <div class="instance">
      <div class="instance-header">
        <div>
          <div class="instance-name">\${htmlEscape(inst.name)}</div>
          <div class="instance-host">\${htmlEscape(inst.user)}@\${htmlEscape(inst.host)}</div>
        </div>
        <span class="badge badge-gray" id="status-\${htmlEscape(inst.id)}">?</span>
      </div>
      <div class="btn-row">
        <button class="btn btn-secondary" onclick="checkStatus('\${htmlEscape(inst.id)}')">🔍 Status</button>
        <button class="btn btn-secondary" onclick="removeInstance('\${htmlEscape(inst.id)}')">🗑 Remove</button>
      </div>
      <div class="status-row" id="status-out-\${htmlEscape(inst.id)}"></div>
    </div>
  \`).join('');
}

function populateSelects() {
  const selects = ['backup-source', 'transfer-source', 'cron-instance'];
  selects.forEach(id => {
    const el = document.getElementById(id);
    el.innerHTML = instances.map(i => \`<option value="\${htmlEscape(i.id)}">\${htmlEscape(i.name)}</option>\`).join('');
  });
  populateHealthSelect();
}

async function checkStatus(id) {
  const badge = document.getElementById('status-' + id);
  const out = document.getElementById('status-out-' + id);
  badge.innerHTML = '<span class="spinner"></span>';
  const result = await api('/instances/' + id + '/status');
  badge.className = 'badge ' + (result.online ? 'badge-green' : 'badge-red');
  badge.textContent = result.online ? 'online' : 'offline';
  out.textContent = result.output?.slice(0, 200) || '';
}

async function addInstance() {
  const inst = {
    name: document.getElementById('add-name').value,
    host: document.getElementById('add-host').value,
    user: document.getElementById('add-user').value,
    ssh_key: document.getElementById('add-key').value || null,
    openclaw_state: '/home/' + document.getElementById('add-user').value + '/.openclaw',
    workspace: '/home/' + document.getElementById('add-user').value + '/.openclaw/workspace',
    backup_dir: '/home/' + document.getElementById('add-user').value,
  };
  await api('/instances', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(inst) });
  loadInstances();
}

async function removeInstance(id) {
  if (!confirm('Remove this instance?')) return;
  await api('/instances/' + id, { method: 'DELETE' });
  loadInstances();
}

async function createBackup() {
  const instanceId = document.getElementById('backup-source').value;
  const log = document.getElementById('backup-log');
  log.classList.remove('hidden');
  log.textContent = 'Starting backup...\\n';
  const result = await api('/backup', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ instanceId }) });
  log.textContent += result.started ? 'Backup started in background. Check logs for progress.\\n' : 'Error starting backup.\\n';
  setTimeout(loadLogs, 2000);
}

async function transferBackup() {
  const sourceId = document.getElementById('transfer-source').value;
  const log = document.getElementById('backup-log');
  log.classList.remove('hidden');
  log.textContent = 'Starting backup + transfer...\\n';
  const result = await api('/transfer', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ sourceId }) });
  if (result.started) {
    log.textContent += \`Transfer running. Log: \${result.logFile}\\nPolling for updates...\\n\`;
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const content = await apiText('/logs/' + result.logFile);
      log.textContent = content;
      log.scrollTop = log.scrollHeight;
      if (content.includes('Transfer complete') || content.includes('ERROR') || attempts > 60) {
        clearInterval(poll);
        loadBackupFiles();
      }
    }, 3000);
  }
}

async function loadBackupFiles() {
  const files = await api('/backups');
  const ul = document.getElementById('backup-files');
  const sel = document.getElementById('restore-backup');
  if (!files.length) {
    ul.innerHTML = '<li style="color:#666;font-size:0.85rem">No backup archives found.</li>';
    sel.innerHTML = '<option>No backups available</option>';
    return;
  }
  ul.innerHTML = files.map(f => \`
    <li>
      <span class="backup-name">\${f.name}<span class="backup-size">(\${(f.size/1024/1024).toFixed(1)}MB)</span></span>
      <button class="btn btn-secondary" style="padding:4px 10px;font-size:0.75rem" onclick="document.getElementById('restore-backup').value='\${f.path}'">Use</button>
    </li>
  \`).join('');
  sel.innerHTML = files.map(f => \`<option value="\${f.path}">\${f.name}</option>\`).join('');
}

async function doRestore() {
  const archivePath = document.getElementById('restore-backup').value;
  const oldUser = document.getElementById('restore-old-user').value;
  const newUser = document.getElementById('restore-new-user').value;
  if (!confirm(\`Restore from \${archivePath.split('/').pop()}?\\nGateway will restart briefly.\`)) return;

  const log = document.getElementById('restore-log');
  log.classList.remove('hidden');
  log.textContent = 'Starting restore...\\n';

  const result = await api('/restore', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ archivePath, oldUser, newUser })
  });

  if (result.started) {
    log.textContent += \`Restore running. Log: \${result.logFile}\\nPolling...\\n\`;
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const content = await apiText('/logs/' + result.logFile);
      log.textContent = content;
      log.scrollTop = log.scrollHeight;
      if (content.includes('Rehydration complete') || content.includes('ERROR') || attempts > 120) {
        clearInterval(poll);
      }
    }, 3000);
  } else {
    log.textContent += 'Error: ' + (result.error || 'unknown');
  }
}

async function loadCrons() {
  const instanceId = document.getElementById('cron-instance').value;
  const out = document.getElementById('cron-output');
  out.classList.remove('hidden');
  out.textContent = 'Loading...';
  const result = await api('/instances/' + instanceId + '/crons');
  out.textContent = result.output || 'No output';
}

async function loadLogs() {
  const files = await api('/logs');
  const sel = document.getElementById('log-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">— select a log —</option>' +
    files.map(f => \`<option value="\${f.name}" \${f.name===current?'selected':''}>\${f.name} (\${(f.size/1024).toFixed(1)}KB)</option>\`).join('');
}

async function loadLog() {
  const file = document.getElementById('log-select').value;
  const el = document.getElementById('log-content');
  if (!file) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.textContent = await apiText('/logs/' + file);
  el.scrollTop = el.scrollHeight;
}

async function runVerification() {
  const instanceId = document.getElementById('health-instance').value;
  if (!instanceId) return;
  const btn = document.getElementById('verify-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Running...';
  document.getElementById('health-score').textContent = 'Running verification...';
  document.getElementById('health-checks').innerHTML = '';
  document.getElementById('health-last-verified').textContent = '';

  try {
    const result = await api('/instances/' + instanceId + '/verify');
    renderHealthResult(result);
  } catch (e) {
    document.getElementById('health-score').textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Run Verification';
  }
}

async function loadCachedHealth() {
  const instanceId = document.getElementById('health-instance').value;
  if (!instanceId) return;
  const result = await api('/instances/' + instanceId + '/verify/cached');
  if (result) renderHealthResult(result);
}

function renderHealthResult(result) {
  const scoreEl = document.getElementById('health-score');
  const checksEl = document.getElementById('health-checks');
  const lastEl = document.getElementById('health-last-verified');

  const score = result.passing + '/' + result.total + ' checks passing';
  const color = result.passing === result.total ? '#4caf50' : result.passing >= result.total * 0.75 ? '#ffc107' : '#f44336';
  scoreEl.innerHTML = \`<strong style="color:\${color}; font-size:1.1rem;">\${score}</strong>\`;

  checksEl.innerHTML = result.checks.map(c => \`
    <div class="check-row">
      <span class="badge \${c.status === 'ok' ? 'badge-ok' : c.status === 'warn' ? 'badge-warn' : 'badge-error'}">\${c.status}</span>
      <span class="check-name">\${c.name}</span>
      <span class="check-detail">\${c.detail || ''}</span>
    </div>
  \`).join('');

  const ts = new Date(result.timestamp).toLocaleString();
  lastEl.textContent = 'Last verified: ' + ts;
}

function populateHealthSelect() {
  const el = document.getElementById('health-instance');
  el.innerHTML = instances.map(i => \`<option value="\${htmlEscape(i.id)}">\${htmlEscape(i.name)}</option>\`).join('');
  loadCachedHealth();
}

loadInstances();
setInterval(loadInstances, 30000);
</script>
</body>
</html>`;
