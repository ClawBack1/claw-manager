#!/usr/bin/env node
// ============================================================
// ClawdBack — OpenClaw backup tool
// Usage: node server.js [port]
//        node server.js --backup <instance-id-or-name>
//        node server.js --list-backups
// Default port: 7788
// ============================================================

const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── CLI mode detection ────────────────────────────────────────
const args = process.argv.slice(2);
const CLI_MODE = args.includes('--backup') || args.includes('--list-backups');

const PORT = process.env.PORT || (!CLI_MODE && args[0] && !args[0].startsWith('--') ? args[0] : 7788);
const INSTANCES_FILE = path.join(__dirname, 'instances.json');
const SCRIPTS_DIR = path.join(os.homedir(), '.openclaw/workspace/scripts');
const BACKUP_DIR = path.join(os.homedir(), 'backups');
const LOG_DIR = path.join(__dirname, 'logs');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

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
    if (readErr.code === 'ENOENT') return [];
    throw readErr;
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

// ── CLI: --list-backups ───────────────────────────────────────

async function cliListBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.tar.gz'))
    .map(f => {
      const full = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(full);
      return { name: f, path: full, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (!files.length) {
    console.log(`No backup archives found in ${BACKUP_DIR}`);
    process.exit(0);
  }

  console.log(`\n📦 Backups in ${BACKUP_DIR}:\n`);
  files.forEach(f => {
    const sizeMB = (f.size / 1024 / 1024).toFixed(1);
    const date = f.mtime.toLocaleString();
    console.log(`  ${f.name}`);
    console.log(`    Size: ${sizeMB} MB   Date: ${date}`);
    console.log(`    Path: ${f.path}\n`);
  });
  process.exit(0);
}

// ── CLI: --backup <instance-id-or-name> ──────────────────────

async function cliBackup(query) {
  const instances = loadInstances();
  const inst = instances.find(i => i.id === query || i.name.toLowerCase() === query.toLowerCase());
  if (!inst) {
    console.error(`❌ Instance not found: "${query}"`);
    if (instances.length) {
      console.error(`Available: ${instances.map(i => `${i.name} (id: ${i.id})`).join(', ')}`);
    } else {
      console.error('No instances configured. Add one via the web UI.');
    }
    process.exit(1);
  }

  console.log(`\n🦀 ClawdBack — Backup`);
  console.log(`   Instance: ${inst.name} (${inst.user}@${inst.host})\n`);

  const logFile = path.join(LOG_DIR, `backup_${inst.id}_${Date.now()}.log`);

  const log = (msg) => {
    console.log(msg);
    fs.appendFileSync(logFile, msg + '\n');
  };

  // Step 1: Create backup archive on remote
  log('▶ Step 1/3: Creating backup archive on remote...');
  const backupCmd = sshCmd(inst, 'openclaw backup create 2>&1');
  const backupResult = await runAsync(backupCmd, logFile);

  if (backupResult.code !== 0) {
    log(`❌ Backup command failed (exit ${backupResult.code})`);
    log(backupResult.stderr || backupResult.stdout);
    process.exit(1);
  }

  // Parse archive path from output
  const archiveMatch = backupResult.stdout.match(/Backup archive:\s*(.+\.tar\.gz)/) ||
                       backupResult.stdout.match(/([^\s\n]+\.tar\.gz)/);
  if (!archiveMatch) {
    log('❌ Could not find archive path in backup output:');
    log(backupResult.stdout.slice(0, 500));
    process.exit(1);
  }

  const remotePath = archiveMatch[1].trim();
  const filename = path.basename(remotePath);
  const localPath = path.join(BACKUP_DIR, filename);
  log(`   ✓ Archive created: ${remotePath}`);

  // Step 2: SCP to ~/backups/
  log(`▶ Step 2/3: Transferring ${filename} → ${BACKUP_DIR}/...`);
  let scpCmd;
  if (inst.host === 'localhost' || inst.host === '127.0.0.1') {
    scpCmd = `cp "${remotePath}" "${localPath}"`;
  } else {
    const key = inst.ssh_key ? `-i ${expandHome(inst.ssh_key)}` : '';
    scpCmd = `scp -o StrictHostKeyChecking=no ${key} ${inst.user}@${inst.host}:"${remotePath}" "${localPath}"`;
  }

  // Check available disk space before transfer
  const sizeCheckCmd = sshCmd(inst, `stat -c%s "${remotePath}"`);
  const sizeResult = await runAsync(sizeCheckCmd, logFile);
  const remoteSize = parseInt(sizeResult.stdout.trim()) || 0;
  const freeResult = await runAsync(`df -B1 "${BACKUP_DIR}" | tail -1 | awk '{print $4}'`, logFile);
  const freeSpace = parseInt(freeResult.stdout.trim()) || 0;
  if (remoteSize > 0 && freeSpace < remoteSize * 1.1) {
    log(`❌ Insufficient disk space: need ${(remoteSize/1024/1024).toFixed(0)}MB, have ${(freeSpace/1024/1024).toFixed(0)}MB free`);
    process.exit(1);
  }
  log(`   Disk space OK: ${(freeSpace/1024/1024).toFixed(0)}MB free`);

  const scpResult = await runAsync(scpCmd, logFile);
  if (scpResult.code !== 0) {
    log('❌ Transfer failed:');
    log(scpResult.stderr);
    process.exit(1);
  }
  log(`   ✓ Transfer complete`);

  // Step 3: Verify archive integrity
  log('▶ Step 3/3: Verifying archive integrity...');
  const verifyResult = await runAsync(`tar -tzf "${localPath}" >/dev/null 2>&1 && echo OK`, logFile);
  if (verifyResult.code !== 0) {
    log('❌ Archive verification failed — file may be corrupt or truncated');
    fs.unlinkSync(localPath);
    process.exit(1);
  }
  log(`   ✓ Archive verified`);

  const stat = fs.statSync(localPath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

  log(`\n✅ Backup complete!`);
  log(`   Archive: ${localPath}`);
  log(`   Size:    ${sizeMB} MB`);
  log(`   Log:     ${logFile}\n`);
  process.exit(0);
}

// ── CLI dispatch ─────────────────────────────────────────────
if (CLI_MODE) {
  if (args.includes('--list-backups')) {
    cliListBackups().catch(e => { console.error('Error:', e.message); process.exit(1); });
  } else if (args.includes('--backup')) {
    const idx = args.indexOf('--backup');
    const query = args[idx + 1];
    if (!query) {
      console.error('Usage: node server.js --backup <instance-id-or-name>');
      process.exit(1);
    }
    cliBackup(query).catch(e => { console.error('Error:', e.message); process.exit(1); });
  }
} else {
  startWebServer();
}

// ── Web server ────────────────────────────────────────────────
function startWebServer() {
  const app = express();
  app.use(express.json());

  // ── API Routes ─────────────────────────────────────────────

  // GET /api/instances
  app.get('/api/instances', (req, res) => {
    res.json(loadInstances());
  });

  // POST /api/instances
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

  // POST /api/backup — trigger backup creation on an instance
  app.post('/api/backup', async (req, res) => {
    const { instanceId } = req.body;
    const inst = loadInstances().find(i => i.id === instanceId);
    if (!inst) return res.status(404).json({ error: 'Not found' });

    const logFile = path.join(LOG_DIR, `backup_${inst.id}_${Date.now()}.log`);
    const cmd = sshCmd(inst, 'openclaw backup create 2>&1');

    res.json({ started: true, logFile: path.basename(logFile) });

    runAsync(cmd, logFile).then(result => {
      console.log(`Backup complete for ${inst.name}: exit ${result.code}`);
    }).catch(err => console.error(`Backup async error for ${inst.name}:`, err));
  });

  // POST /api/transfer — backup remote instance and SCP to ~/backups/
  app.post('/api/transfer', async (req, res) => {
    const { sourceId } = req.body;
    const source = loadInstances().find(i => i.id === sourceId);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const logFile = path.join(LOG_DIR, `transfer_${sourceId}_${Date.now()}.log`);
    const log = (msg) => { rotateLogIfNeeded(logFile); fs.appendFileSync(logFile, msg + '\n'); };

    res.json({ started: true, logFile: path.basename(logFile) });

    try {
      log('=== Step 1: Creating backup on source ===');
      const backupCmd = sshCmd(source, 'openclaw backup create 2>&1');
      const backupResult = await runAsync(backupCmd, logFile);

      const archiveMatch = backupResult.stdout.match(/Backup archive:\s*(.+\.tar\.gz)/) ||
                           backupResult.stdout.match(/([^\s\n]+\.tar\.gz)/);
      if (!archiveMatch) {
        log('ERROR: Could not find backup archive path in output');
        log(backupResult.stdout);
        log(backupResult.stderr);
        return;
      }

      const remotePath = archiveMatch[1].trim();
      const filename = path.basename(remotePath);
      const localPath = path.join(BACKUP_DIR, filename);

      log(`\n=== Step 2: Transferring ${filename} ===`);

      let scpCmd;
      if (source.host === 'localhost' || source.host === '127.0.0.1') {
        scpCmd = `cp "${remotePath}" "${localPath}"`;
      } else {
        const key = source.ssh_key ? `-i ${expandHome(source.ssh_key)}` : '';
        scpCmd = `scp -o StrictHostKeyChecking=no ${key} ${source.user}@${source.host}:"${remotePath}" "${localPath}"`;
      }

      // Check available disk space before transfer
      const sizeResult = await runAsync(sshCmd(source, `stat -c%s "${remotePath}"`), logFile);
      const remoteSize = parseInt(sizeResult.stdout.trim()) || 0;
      const freeResult = await runAsync(`df -B1 "${BACKUP_DIR}" | tail -1 | awk '{print $4}'`, logFile);
      const freeSpace = parseInt(freeResult.stdout.trim()) || 0;
      if (remoteSize > 0 && freeSpace < remoteSize * 1.1) {
        log(`ERROR: Insufficient disk space: need ${(remoteSize/1024/1024).toFixed(0)}MB, have ${(freeSpace/1024/1024).toFixed(0)}MB free`);
        return;
      }
      log(`Disk space OK: ${(freeSpace/1024/1024).toFixed(0)}MB free, archive is ${(remoteSize/1024/1024).toFixed(1)}MB`);

      const scpResult = await runAsync(scpCmd, logFile);
      if (scpResult.code !== 0) {
        log('ERROR: SCP failed');
        log(scpResult.stderr);
        return;
      }

      // Verify archive integrity after transfer
      log('Verifying archive integrity...');
      const verifyResult = await runAsync(`tar -tzf "${localPath}" >/dev/null 2>&1 && echo OK`, logFile);
      if (verifyResult.code !== 0) {
        log('ERROR: Archive verification failed — file may be corrupt or truncated');
        fs.unlinkSync(localPath);
        return;
      }
      log('✅ Archive integrity verified');

      const stat = fs.statSync(localPath);
      log(`Transfer complete: ${localPath}`);
      log(`Size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
      log('\n=== Transfer complete ===');
      log(`Archive ready at: ${localPath}`);
    } catch (err) {
      console.error('Transfer async error:', err);
      log(`\nFATAL ERROR: ${err.message}`);
    }
  });

  // POST /api/restore — run rehydrate.sh with archive
  const SAFE_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

  app.post('/api/restore', async (req, res) => {
    const { archivePath, oldUser, newUser } = req.body;

    const resolvedOldUser = oldUser || 'openclaw';
    const resolvedNewUser = newUser || os.userInfo().username;

    if (!SAFE_USERNAME_RE.test(resolvedOldUser)) {
      return res.status(400).json({ error: `Invalid oldUser: ${resolvedOldUser}` });
    }
    if (!SAFE_USERNAME_RE.test(resolvedNewUser)) {
      return res.status(400).json({ error: `Invalid newUser: ${resolvedNewUser}` });
    }
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
    const cmd = `bash "${rehydrateScript}" "${resolvedArchive}" "${resolvedOldUser}" "${resolvedNewUser}"`;

    res.json({ started: true, logFile: path.basename(logFile) });

    runAsync(cmd, logFile).then(r => {
      console.log(`Restore done: exit ${r.code}`);
    }).catch(err => console.error('Restore async error:', err));
  });

  // GET /api/backups — list archives in ~/backups/
  app.get('/api/backups', (req, res) => {
    try {
      const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.tar.gz'))
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

  // GET /api/logs/:file
  app.get('/api/logs/:file', (req, res) => {
    const safeName = path.basename(req.params.file);
    const logFile = path.join(LOG_DIR, safeName);
    if (!logFile.startsWith(LOG_DIR + path.sep) && logFile !== LOG_DIR) {
      return res.status(400).json({ error: 'Invalid log file path' });
    }
    if (!fs.existsSync(logFile)) return res.status(404).json({ error: 'Not found' });
    const content = fs.readFileSync(logFile, 'utf8');
    res.type('text/plain').send(content);
  });

  // GET /api/logs
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

  // Frontend
  app.get('/', (req, res) => res.send(HTML));

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🦀 ClawdBack running at http://0.0.0.0:${PORT} — open in browser or use CLI`);
  });
}

// ── HTML frontend ─────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🦀 ClawdBack</title>
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
  .full-width { grid-column: 1 / -1; }
</style>
</head>
<body>
<header>
  <span style="font-size:1.6rem">🦀</span>
  <h1>ClawdBack</h1>
  <span>Backup Tool</span>
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
        <div class="section-title">Transfer (Backup Source → This Machine ~/backups/)</div>
        <select id="transfer-source"></select>
        <button class="btn btn-success" onclick="transferBackup()">⬇ Backup + Transfer Here</button>
      </div>

      <div id="backup-log" class="log-area hidden"></div>
    </div>

    <!-- Restore -->
    <div class="card">
      <h2>🔄 Restore</h2>
      <div class="section-title">Available Backups (~/backups/)</div>
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
  if (!instances.length) {
    el.innerHTML = '<p style="color:#666;font-size:0.85rem">No instances configured.</p>';
    return;
  }
  el.innerHTML = instances.map(inst => \`
    <div class="instance">
      <div class="instance-header">
        <div>
          <div class="instance-name">\${htmlEscape(inst.name)}</div>
          <div class="instance-host">\${htmlEscape(inst.user)}@\${htmlEscape(inst.host)}</div>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn btn-secondary" onclick="removeInstance('\${htmlEscape(inst.id)}')">🗑 Remove</button>
      </div>
    </div>
  \`).join('');
}

function populateSelects() {
  ['backup-source', 'transfer-source'].forEach(id => {
    const el = document.getElementById(id);
    el.innerHTML = instances.map(i => \`<option value="\${htmlEscape(i.id)}">\${htmlEscape(i.name)}</option>\`).join('');
  });
}

async function addInstance() {
  const user = document.getElementById('add-user').value;
  const inst = {
    name: document.getElementById('add-name').value,
    host: document.getElementById('add-host').value,
    user,
    ssh_key: document.getElementById('add-key').value || null,
    openclaw_state: '/home/' + user + '/.openclaw',
    workspace: '/home/' + user + '/.openclaw/workspace',
    backup_dir: '/home/' + user + '/backups',
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
  const result = await api('/backup', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ instanceId })
  });
  if (result.started) {
    log.textContent += \`Backup running. Log: \${result.logFile}\\nPolling for updates...\\n\`;
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const content = await apiText('/logs/' + result.logFile);
      log.textContent = content;
      log.scrollTop = log.scrollHeight;
      if (content.includes('[exit 0]') || content.includes('[exit 1]') || attempts > 60) {
        clearInterval(poll);
        loadLogs();
      }
    }, 3000);
  } else {
    log.textContent += 'Error: ' + (result.error || 'unknown');
  }
}

async function transferBackup() {
  const sourceId = document.getElementById('transfer-source').value;
  const log = document.getElementById('backup-log');
  log.classList.remove('hidden');
  log.textContent = 'Starting backup + transfer...\\n';
  const result = await api('/transfer', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ sourceId })
  });
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
        loadLogs();
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
      <span class="backup-name">\${htmlEscape(f.name)}<span class="backup-size">(\${(f.size/1024/1024).toFixed(1)}MB)</span></span>
      <button class="btn btn-secondary" style="padding:4px 10px;font-size:0.75rem"
        onclick="document.getElementById('restore-backup').value='\${htmlEscape(f.path)}'">Use</button>
    </li>
  \`).join('');
  sel.innerHTML = files.map(f => \`<option value="\${htmlEscape(f.path)}">\${htmlEscape(f.name)}</option>\`).join('');
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
        loadLogs();
      }
    }, 3000);
  } else {
    log.textContent += 'Error: ' + (result.error || 'unknown');
  }
}

async function loadLogs() {
  const files = await api('/logs');
  const sel = document.getElementById('log-select');
  const current = sel.value;
  sel.innerHTML = '<option value="">— select a log —</option>' +
    files.map(f => \`<option value="\${htmlEscape(f.name)}" \${f.name===current?'selected':''}>\${htmlEscape(f.name)} (\${(f.size/1024).toFixed(1)}KB)</option>\`).join('');
}

async function loadLog() {
  const file = document.getElementById('log-select').value;
  const el = document.getElementById('log-content');
  if (!file) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.textContent = await apiText('/logs/' + file);
  el.scrollTop = el.scrollHeight;
}

loadInstances();
setInterval(loadInstances, 30000);
</script>
</body>
</html>`;
