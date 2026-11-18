'use strict';
// The stored proof of one full validation of a cached payload (UX-070 FS).
//
// A warm start hashed every pinned member of the image it runs, on every start.
// After a full validation the launcher now records what it validated: the
// release pins, the payload root, and for every file of the walk its name, file
// identity, size, write time and change time. A later start walks the payload
// the same way, with every link, boundary, size and member-set check, and skips
// only the member hashes while that record names exactly the files it finds.
// Any difference, a missing or foreign record, STACKBITE_PACKAGE_PROOF=verify or
// =off, setup, removal, first publication and repair all hash every member.
//
// The record lives in the installation's existing update directory, which the
// verified native engine creates privately; this file never creates it, so an
// installation without one keeps hashing on every start.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ENVIRONMENT = 'STACKBITE_PACKAGE_PROOF';
const SCHEMA = 'stackbite-npm-payload-proof-v1';
const DIRECTORY = ['.stackbite-update', 'package-proof'];
const MAX_RECORD = 4096;

// A directory or record this user owns that no other user may write.
function owned(info) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return true;
  return info.uid === process.getuid() && (info.mode & 0o022) === 0;
}
// The existing private store of this installation, or null.
function store(root) {
  try {
    let directory = root;
    for (const name of [null, ...DIRECTORY]) {
      if (name) directory = path.join(directory, name);
      const info = fs.lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)) return null;
    }
    return directory;
  } catch { return null; }
}
// null: every member is hashed and nothing is recorded.
function select(environment, root) {
  const mode = environment[ENVIRONMENT];
  if (mode === 'off') return null;
  const directory = store(root);
  return directory ? { store: directory, renew: mode === 'verify', taken: false } : null;
}
// What identifies one file of the walk without reading it.
function stamp(relative, resolved) {
  const info = fs.lstatSync(resolved, { bigint: true });
  return [relative, String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)];
}
function claim(root, spec, deferPhone, stamps) {
  return createHash('sha256').update(JSON.stringify([SCHEMA, root, spec.key, spec.version, spec.commit,
    spec.manifestSha256, spec.metadataSha256, Boolean(deferPhone), stamps])).digest('hex');
}
function recordPath(proof, root) {
  return path.join(proof.store, createHash('sha256').update(root).digest('hex').slice(0, 32) + '.npm.json');
}
function holds(proof, root, value) {
  try {
    const file = recordPath(proof, root), info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD || !owned(info)) return false;
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.keys(document).sort().join(',') === 'claim,schema' && document.schema === SCHEMA && document.claim === value;
  } catch { return false; }
}
// Best effort: a start that cannot record its proof hashes again next time.
function keep(proof, root, value) {
  const file = recordPath(proof, root), temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schema: SCHEMA, claim: value }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch { try { fs.unlinkSync(temporary); } catch { /* nothing was written */ } }
}

module.exports = { ENVIRONMENT, SCHEMA, select, stamp, claim, holds, keep };
