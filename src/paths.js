// Filesystem locations used by grok-tabs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where `install` puts the launcher script. Override with GROK_TABS_HOME.
export function homeDir() {
  return process.env.GROK_TABS_HOME || path.join(os.homedir(), '.grok-tabs');
}

// Directory holding the per-browser Unix sockets. Prefer XDG_RUNTIME_DIR
// (tmpfs, per-user, 0700 on systemd systems); otherwise ~/.grok-tabs/run.
export function runDir() {
  if (process.env.GROK_TABS_RUN_DIR) return process.env.GROK_TABS_RUN_DIR;
  if (process.env.XDG_RUNTIME_DIR) return path.join(process.env.XDG_RUNTIME_DIR, 'grok-tabs');
  return path.join(homeDir(), 'run');
}

export function launcherPath() {
  return path.join(homeDir(), 'grok-tabs-host');
}

// Create the run dir with mode 0700 and refuse to use one that another user
// owns or that is group/world accessible after we tried to fix it.
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`${dir} is owned by uid ${st.uid}, not by the current user`);
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

export function socketPathFor(pid = process.pid) {
  return path.join(runDir(), `host-${pid}.sock`);
}

// Directories clients search. The host may have been started with a different
// environment than the client (e.g. a desktop MCP client launched without
// XDG_RUNTIME_DIR), so look in both the XDG and the home fallback location.
export function searchDirs() {
  if (process.env.GROK_TABS_RUN_DIR) return [process.env.GROK_TABS_RUN_DIR];
  const dirs = [runDir(), path.join(homeDir(), 'run')];
  if (!process.env.XDG_RUNTIME_DIR && typeof process.getuid === 'function') {
    dirs.push(path.join('/run/user', String(process.getuid()), 'grok-tabs'));
  }
  return [...new Set(dirs)];
}

// All candidate sockets, most recently created first.
export function listSockets() {
  const found = [];
  for (const dir of searchDirs()) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.sock')) continue;
      const p = path.join(dir, n);
      try {
        found.push({ path: p, mtimeMs: fs.lstatSync(p).mtimeMs });
      } catch {}
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((s) => s.path);
}
