'use strict';
// Which stackbite command will the user's shell run after this npm package is
// installed? PATH order decides, and an older launcher earlier on PATH keeps
// running its own version. This module only reads: it names the command PATH
// picks, the version it runs and the next action. It never writes, replaces or
// runs the command it finds. Ownership of a launcher is established only by the
// installer grammar AND the verified pinned engine's own --managed-launcher
// answer; the engine remains the only writer of launchers. Since U01 the
// engine's npm publication (--record-install TARGET - SOURCE cache) itself
// points an older managed launcher of the same installation at the published
// runtime and says so; this check runs after it and reports what is left
// (a launcher it declined to move, another npm installation, a foreign file).
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readSmall } = require('./common');

const RELATIVE = 'packaging/npm/bin/stackbite.js';
const LIMIT = 64 * 1024;
const SKIPPED = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EISDIR', 'ENAMETOOLONG', 'EINVAL'];

const folded = (value, windows) => (windows ? path.resolve(value).toLowerCase() : path.resolve(value));
function variable(environment, name, windows) {
  const key = Object.keys(environment).find(item => (windows ? item.toUpperCase() === name : item === name));
  return key === undefined ? '' : String(environment[key]);
}

// Absolute PATH directories in order, each once.
function pathDirectories(environment, windows) {
  const seen = new Set(), directories = [];
  for (let entry of variable(environment, 'PATH', windows).split(path.delimiter)) {
    if (windows) entry = entry.replace(/^"(.*)"$/, '$1');
    if (!entry || !path.isAbsolute(entry)) continue;
    const key = folded(entry, windows);
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push(path.resolve(entry));
  }
  return directories;
}
// The names a shell tries in one directory: PATHEXT order on Windows (plus the
// .ps1 that PowerShell also runs), the bare name elsewhere.
function commandNames(environment, windows) {
  if (!windows) return ['stackbite'];
  const extensions = (variable(environment, 'PATHEXT', true) || '.COM;.EXE;.BAT;.CMD').split(';')
    .map(item => item.trim().toLowerCase()).filter(item => /^\.[a-z0-9]{1,8}$/.test(item));
  return [...new Set([...extensions, '.ps1'])].map(extension => 'stackbite' + extension);
}
// The first command file of each PATH directory that has one, in PATH order.
async function pathCommands(environment, platform) {
  const windows = platform === 'win32', names = commandNames(environment, windows), found = [];
  for (const directory of pathDirectories(environment, windows)) {
    for (const name of names) {
      const file = path.join(directory, name);
      let info;
      try { info = await fs.stat(file); }
      catch (error) { if (SKIPPED.includes(error.code)) continue; throw error; }
      if (!info.isFile()) continue;
      // A POSIX shell skips a file it may not execute.
      if (!windows && process.platform !== 'win32' && !(info.mode & 0o111)) continue;
      found.push({ directory, file });
      break;
    }
  }
  return found;
}

function shellLiteral(value) {
  if (typeof value !== 'string' || value.length < 2 || !value.startsWith("'") || !value.endsWith("'")) return null;
  const parts = value.slice(1, -1).split("'\\''");
  return parts.some(part => /['\r\n\0]/.test(part)) ? null : parts.join("'");
}
// The exact installer grammar (resolver.rs managed_cmd / managed_sh): the image
// home a managed launcher runs, or null. Grammar alone is not ownership.
function managedLauncher(text, windows) {
  if (windows) {
    const lines = text.replaceAll('\r\n', '\n').split('\n');
    if (lines[1] === 'rem Stackbite managed launcher') lines.splice(1, 1);
    if (lines.length !== 7 || lines[0] !== '@echo off' || lines[1] !== 'setlocal'
        || lines[5] !== 'exit /b %errorlevel%' || lines[6] !== '') return null;
    for (const prefix of ['STACKBITE', 'HELM']) {
      const field = (line, name) => (line.startsWith('set "' + prefix + '_' + name + '=') && line.endsWith('"')
        ? line.slice(('set "' + prefix + '_' + name + '=').length, -1) : null);
      const home = field(lines[2], 'HOME'), state = field(lines[3], 'STATE_DIR');
      const image = lines[4].startsWith('"') && lines[4].endsWith('" %*') ? lines[4].slice(1, -4) : null;
      if (home === null || state === null || image === null) continue;
      if ([home, state, image].some(value => !value || /["%\0\r\n]/.test(value))) return null;
      const parts = value => value.replaceAll('/', '\\').split('\\');
      if (parts(home).includes('..') || parts(image).includes('..')) return null;
      const name = parts(image).at(-1).toLowerCase(), parent = parts(image).slice(0, -1).join('\\').toLowerCase();
      if (!['stackbite.exe', 'helm.exe', 'stackbite-launcher.exe'].includes(name)
          || parent !== parts(home).join('\\').toLowerCase()) return null;
      return { home, image };
    }
    return null;
  }
  if (text.includes('\r')) return null;
  const lines = text.split('\n');
  if (lines.length !== 8 || lines[0] !== '#!/bin/sh'
      || !['# Stackbite managed launcher', '# Helm managed launcher'].includes(lines[1])
      || lines[5] !== 'fi' || lines[7] !== '') return null;
  for (const prefix of ['STACKBITE', 'HELM']) {
    if (lines[2] !== 'if [ -z "$' + '{' + prefix + '_STATE_DIR:-}" ]; then' || lines[4] !== '  export ' + prefix + '_STATE_DIR') continue;
    const assign = '  ' + prefix + '_STATE_DIR=';
    const state = lines[3].startsWith(assign) ? shellLiteral(lines[3].slice(assign.length)) : null;
    const image = lines[6].startsWith('exec ') && lines[6].endsWith(' "$@"') ? shellLiteral(lines[6].slice(5, -5)) : null;
    if (state === null || image === null || !image.includes('/')) return null;
    const name = image.slice(image.lastIndexOf('/') + 1);
    if (!['stackbite', 'helm', 'stackbite-launcher'].includes(name)) return null;
    return { home: image.slice(0, image.lastIndexOf('/')) || '/', image };
  }
  return null;
}

const printable = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value);
async function jsonFile(file, limit = 16384) {
  try {
    const value = JSON.parse((await readSmall(file, limit)).toString('utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
// The npm package (name stackbite) whose bin entry is file, or null.
async function packageOf(entry) {
  const normalized = entry.split(path.sep).join('/');
  if (!normalized.endsWith('/' + RELATIVE)) return null;
  const root = entry.slice(0, entry.length - RELATIVE.length - 1);
  const metadata = await jsonFile(path.join(root, 'package.json'), 1024 * 1024);
  return metadata?.name === 'stackbite' ? { root, version: printable(metadata.version) ? metadata.version : null } : null;
}
async function boundedText(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT) return null;
  return (await fs.readFile(file)).toString('utf8');
}

// What the PATH command is, from bounded reads only. kind: npm (an npm command
// of a stackbite package), launcher (installer grammar), unknown.
async function describeCommand(command, platform) {
  const windows = platform === 'win32';
  let real = null;
  try { real = await fs.realpath(command.file); } catch { /* described from the name alone */ }
  if (real) {
    const linked = await packageOf(real);
    if (linked) return { kind: 'npm', root: linked.root, version: linked.version, commit: null };
  }
  let text = null;
  try { text = await boundedText(command.file); } catch { /* unreadable: unknown */ }
  if (text === null) return { kind: 'unknown', version: null, commit: null };
  if (windows && text.replaceAll('\\', '/').includes('node_modules/stackbite/' + RELATIVE)) {
    const shimmed = await packageOf(path.join(command.directory, 'node_modules', 'stackbite', ...RELATIVE.split('/')));
    if (shimmed) return { kind: 'npm', root: shimmed.root, version: shimmed.version, commit: null };
  }
  const launcher = managedLauncher(text, windows);
  if (!launcher) return { kind: 'unknown', version: null, commit: null };
  const metadata = await jsonFile(path.join(launcher.home, 'portable.json'));
  return { kind: 'launcher', home: launcher.home,
    version: printable(metadata?.version) ? metadata.version : null,
    commit: typeof metadata?.commit === 'string' && /^[a-f0-9]{40}$/.test(metadata.commit) ? metadata.commit : null };
}

// This package's own global npm command, or null when it is not a global registration.
async function ownCommand(packageRoot, platform) {
  const prefix = await require('./uninstall-registration').registration(packageRoot, platform);
  if (prefix === null) return null;
  return { root: path.resolve(packageRoot), directory: platform === 'win32' ? prefix : path.join(prefix, 'bin') };
}
async function sameDirectory(a, b, windows) {
  if (folded(a, windows) === folded(b, windows)) return true;
  try { return folded(await fs.realpath(a), windows) === folded(await fs.realpath(b), windows); } catch { return false; }
}

// The verified engine's existing ownership answer (exit 0: the installer may
// replace this launcher). Read-only; any failure or delay is "not proven".
function engineProvesManaged(engine, file, environment, spawnImpl = spawn, timeout = 10000) {
  return new Promise(resolve => {
    let done = false, timer = null;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    try {
      const child = spawnImpl(engine, ['--managed-launcher', file], { env: environment, stdio: 'ignore', shell: false, windowsHide: true });
      timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(false); }, timeout);
      timer.unref?.();
      child.once('error', () => finish(false));
      child.once('exit', (code, signal) => finish(code === 0 && !signal));
    } catch { finish(false); }
  });
}

function newer(a, b) {
  const parse = value => (/^(\d+)\.(\d+)\.(\d+)$/.exec(value) || []).slice(1).map(Number);
  const left = parse(a), right = parse(b);
  if (left.length !== 3 || right.length !== 3) return false;
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index];
  return false;
}
// A path that can be pasted inside the quotes of the suggested command.
const quotable = (value, windows) => (windows ? !/["%\0\r\n]/.test(value) : !/[\0\r\n]/.test(value));
const quoted = (value, windows) => (windows ? '"' + value + '"' : "'" + value.replaceAll("'", "'\\''") + "'");

async function installerOf(home, windows) {
  const file = path.join(home, windows ? 'install.ps1' : 'install.sh');
  try { const info = await fs.lstat(file); return info.isFile() && !info.isSymbolicLink() ? file : null; } catch { return null; }
}

// The finding, or null when the shell already runs this package's version (or
// nothing can be said: no PATH, no command, not a global npm registration).
async function inspectCommandResolution({ spec, installed, environment = process.env, platform = spec.platform,
  packageRoot = path.resolve(__dirname, '../../..'), spawnImpl = spawn, proofTimeout = 10000 }) {
  const windows = platform === 'win32';
  const own = await ownCommand(packageRoot, platform);
  if (!own) return null;
  const commands = await pathCommands(environment, platform);
  if (!commands.length) return null;
  const winner = commands[0];
  let ownIndex = -1;
  for (let index = 0; index < commands.length && ownIndex < 0; index++) {
    if (await sameDirectory(commands[index].directory, own.directory, windows)) ownIndex = index;
  }
  const described = await describeCommand(winner, platform);
  if (described.kind === 'npm' && await sameDirectory(described.root, own.root, windows)) return null;
  if (described.version === spec.version && (described.commit === null || described.commit === spec.commit)) return null;
  const finding = { expected: spec.version, winner: { file: winner.file, directory: winner.directory, kind: described.kind,
    version: described.version, managed: false },
  own: ownIndex < 0 ? { directory: own.directory, file: null } : { directory: own.directory, file: commands[ownIndex].file },
  fix: null };
  if (described.kind === 'launcher' && installed?.home) {
    const engine = path.join(installed.home, 'stackbite' + (windows ? '.exe' : ''));
    finding.winner.managed = await engineProvesManaged(engine, winner.file,
      { ...environment, STACKBITE_HOME: path.resolve(installed.home) }, spawnImpl, proofTimeout);
  }
  const installer = finding.winner.managed ? await installerOf(installed.home, windows) : null;
  if (described.version && newer(described.version, spec.version)) {
    finding.fix = { kind: 'update-package', command: 'npm install --global stackbite@' + described.version };
  } else if (installer && quotable(installer, windows)) {
    finding.fix = { kind: 'update-launcher', command: windows
      ? 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + quoted(installer, true)
      : 'sh ' + quoted(installer, false) };
  } else if (finding.own.file && quotable(finding.own.file, windows)) {
    finding.fix = { kind: 'run-package', command: (windows ? '& ' : '') + quoted(finding.own.file, windows) + ' --version' };
  }
  return finding;
}

function describeFinding(finding) {
  const { winner, own, fix, expected } = finding;
  const what = winner.kind === 'launcher'
    ? (winner.managed ? 'a StackBite-managed launcher (ownership verified)' : 'a launcher whose StackBite ownership could not be verified')
    : winner.kind === 'npm' ? 'another npm installation of stackbite' : 'a file StackBite did not create or cannot identify';
  const lines = [
    'warning: the "stackbite" command in your shell does not run this npm package (' + expected + ').',
    '  PATH picks: ' + winner.file,
    '  It is ' + what + ' and runs ' + (winner.version ? 'version ' + winner.version : 'an unknown version') + '.',
    own.file ? '  This package: ' + own.file + ' (later on PATH, so it is not used).'
      : '  This package: ' + own.directory + ' (no stackbite command from it is on PATH).'];
  if (fix?.kind === 'update-launcher') lines.push('  To make that launcher run ' + expected + ': ' + fix.command);
  else if (fix?.kind === 'update-package') lines.push('  This npm package is older. To update it: ' + fix.command);
  else {
    lines.push('  StackBite left ' + winner.file + ' unchanged.',
      '  To use ' + expected + ', put ' + own.directory + ' before ' + winner.directory + ' on PATH,'
        + (winner.kind === 'unknown' ? ' or remove that file yourself if it is stale.' : ' or remove the other copy.'));
    if (fix?.kind === 'run-package') lines.push('  To run this package now: ' + fix.command);
  }
  return lines.map(line => 'Stackbite: ' + line + '\n').join('');
}

// Advisory: a failed inspection says nothing and never fails the install.
async function reportCommandResolution(options) {
  try {
    const finding = await inspectCommandResolution(options);
    if (finding) (options.stderr || process.stderr).write(describeFinding(finding));
    return finding;
  } catch { return null; }
}

module.exports = { reportCommandResolution, inspectCommandResolution, describeFinding, managedLauncher, pathCommands };
