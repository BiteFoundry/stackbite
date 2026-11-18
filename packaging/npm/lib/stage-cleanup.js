'use strict';
// Staging ownership and cleanup settlement for the npm bootstrap.
//
// A stage is owned only by the invocation that created it: createStage records
// the identity of its own mkdtemp directory, and removeStage removes nothing
// whose path, name or identity is not that record. A cleanup failure is debt,
// never the outcome: settleCleanup keeps the primary error as the thrown error
// and reports the leftover path separately.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const PREFIX = 'stackbite-npm-';
const owned = new Map();

async function createStage() {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), PREFIX));
  const info = await fs.lstat(staging, { bigint: true });
  owned.set(staging, { dev: info.dev, ino: info.ino });
  return staging;
}

function unsafe(message, staging) {
  return Object.assign(new Error(message), { code: 'STACKBITE_STAGE_NOT_OWNED', path: staging });
}

async function removeStage(staging) {
  // Only this invocation's mkdtemp directory is owned.
  const identity = owned.get(staging);
  if (!identity || path.dirname(staging) !== path.resolve(os.tmpdir()) || !path.basename(staging).startsWith(PREFIX)) {
    throw unsafe('Unsafe staging cleanup path', staging);
  }
  let info;
  try { info = await fs.lstat(staging, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') { owned.delete(staging); return; } throw error; }
  // A replaced directory or a link at the same name is somebody else's object.
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino) {
    throw unsafe('Staging directory changed after it was created; it was left in place', staging);
  }
  // Windows scanners and indexers hold new files briefly; fs.rm retries those.
  await fs.rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  owned.delete(staging);
}

function stageOwned(staging) { return owned.has(staging); }

// One line per leftover; the path is the user's own temporary or data directory.
function debtReporter(stderr) {
  return (debt, primaryFailed) => {
    const reason = debt.code || 'error';
    stderr.write(`Stackbite: ${debt.kind} cleanup did not finish (${reason}); left in place: ${debt.path}\n`
      + (primaryFailed
        ? 'Stackbite: that leftover is separate from the error reported below and did not cause it.\n'
        : 'Stackbite: the runtime itself is installed; that leftover can be deleted.\n'));
  };
}

// Run one cleanup after the guarded work. `primary` is { failed, error } of that
// work. The cleanup failure is recorded on the primary error (cleanupDebt) and
// reported; it is thrown only when the work succeeded and `required` is set.
async function settleCleanup(primary, action, entry, report = () => {}) {
  try { await action(); }
  catch (error) {
    const debt = { kind: entry.kind, path: entry.path,
      code: typeof error?.code === 'string' ? error.code : null,
      message: error instanceof Error ? error.message : String(error) };
    if (primary.failed) {
      const target = primary.error;
      if (target && typeof target === 'object') {
        try {
          if (Array.isArray(target.cleanupDebt)) target.cleanupDebt.push(debt);
          else Object.defineProperty(target, 'cleanupDebt', { value: [debt], enumerable: false, writable: true, configurable: true });
        } catch { /* a frozen primary error still stays the outcome */ }
      }
    }
    try { report(debt, primary.failed); } catch { /* reporting never changes the outcome */ }
    if (!primary.failed && entry.required) throw error;
  }
}

module.exports = { createStage, removeStage, stageOwned, settleCleanup, debtReporter };
