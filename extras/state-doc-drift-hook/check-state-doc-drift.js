#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DRIFT_BYTES = parseInt(process.env.CML_DRIFT_BYTES || '', 10) || 1_500_000;
const MIN_TURN_BYTES = parseInt(process.env.CML_DRIFT_MIN_TURN_BYTES || '', 10) || 20_000;
const COOLDOWN_MS = parseInt(process.env.CML_DRIFT_COOLDOWN_MS || '', 10) || 20 * 60 * 1000;
const STATE_DIR = path.join(os.homedir(), '.claude', 'hooks', '.state-doc-drift');
const DOCS = (process.env.CML_DRIFT_DOCS || 'TODO.md,NOTES.md,HANDOFF.md')
  .split(',').map((d) => d.trim()).filter(Boolean);
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function pruneStateDir() {
  let entries;
  try { entries = fs.readdirSync(STATE_DIR); } catch { return; }
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const name of entries) {
    const p = path.join(STATE_DIR, name);
    const st = safeStat(p);
    if (st && st.mtimeMs < cutoff) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
}

function persist(file, state) {
  try {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.copyFileSync(tmp, file);
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

function main() {
  const input = readInput();
  if (!input) return;
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  if (!cwd || !transcriptPath || !/^[A-Za-z0-9-]+$/.test(sessionId)) return;

  if (!DOCS.some((d) => safeStat(path.join(cwd, d)))) return;

  const tStat = safeStat(transcriptPath);
  if (!tStat) return;
  const size = tStat.size;
  const tBirth = Math.round(tStat.birthtimeMs || 0);

  let docMtime = 0;
  for (const d of DOCS) {
    const st = safeStat(path.join(cwd, d));
    if (st && st.mtimeMs > docMtime) docMtime = st.mtimeMs;
  }

  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}
  const stateFile = path.join(STATE_DIR, sessionId + '.json');
  let state = null;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}

  const now = Date.now();
  if (!state || typeof state.watermarkSize !== 'number') {
    persist(stateFile, { watermarkSize: size, docMtime, lastStopSize: size, cooldownUntil: 0, tBirth });
    pruneStateDir();
    return;
  }

  if (size < state.watermarkSize || size < state.lastStopSize || Math.abs(tBirth - (state.tBirth || tBirth)) > 1000) {
    persist(stateFile, { watermarkSize: size, docMtime, lastStopSize: size, cooldownUntil: state.cooldownUntil || 0, tBirth });
    return;
  }

  if (input.stop_hook_active) {
    state.lastStopSize = size;
    persist(stateFile, state);
    return;
  }

  const turnDelta = size - (typeof state.lastStopSize === 'number' ? state.lastStopSize : size);
  const docsTouched = docMtime > (state.docMtime || 0);
  if (docsTouched) {
    state.watermarkSize = size;
    state.docMtime = docMtime;
  }
  const drift = size - state.watermarkSize;
  state.lastStopSize = size;

  const fire =
    !docsTouched &&
    drift > DRIFT_BYTES &&
    turnDelta > MIN_TURN_BYTES &&
    now > (state.cooldownUntil || 0);

  if (fire) {
    state.watermarkSize = size;
    state.cooldownUntil = now + COOLDOWN_MS;
    if (!persist(stateFile, state)) return;
    const mb = (drift / 1_000_000).toFixed(1);
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason:
        'State-doc drift check: ~' + mb + ' MB of conversation since the state docs in this project (' + DOCS.filter((d) => safeStat(path.join(cwd, d))).join(', ') + ') were last updated. ' +
        'If any task was completed, changed status, or produced findings worth keeping, update those docs now, then end the turn. ' +
        'If nothing needs recording, end the turn without further changes.',
    }));
    return;
  }

  persist(stateFile, state);
}

try { main(); } catch {}
process.exit(0);
