'use strict';

// End-to-end test: drive the real wrapper through a pseudo-terminal and assert
// it injects the save prompt then the compact command on idle, and that unsent
// input defers it. Requires node-pty, so it is skipped if that fails to load.
// Thresholds are shrunk to milliseconds via CML_* env so the test runs fast.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

let pty;
try {
  pty = require('@homebridge/node-pty-prebuilt-multiarch');
} catch {
  pty = null;
}

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const MOCK = path.join(__dirname, 'mock-agent.js');

function spawnWrapped(extraEnv) {
  const env = Object.assign({}, process.env, {
    CML_NO_TRANSCRIPT: '1',
    CML_IDLE_MS: '400',
    CML_GRACE_MS: '3600000',
    CML_SIZE_GATE: '0',
    CML_SETTLE_QUIET_MS: '250',
    CML_MIN_TURN_MS: '250',
    CML_MAX_PHASE_MS: '600000',
    CML_SWEEP_MS: '80',
    CML_INJECT_DELAY_MS: '120',
    CML_SAVE_PROMPT: 'SAVESTATE_MARKER',
    CML_COMPACT_CMD: '/compact',
  }, extraEnv || {});
  const term = pty.spawn(process.execPath, [CLI, '--', process.execPath, MOCK], {
    name: 'xterm-256color', cols: 80, rows: 30, cwd: __dirname, env,
  });
  let buf = '';
  term.onData((d) => { buf += d; });
  return { term, out: () => buf };
}

function waitFor(getOut, needle, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (getOut().includes(needle)) { clearInterval(iv); resolve(true); }
      else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error('timeout waiting for ' + JSON.stringify(needle) + '\n--- output ---\n' + getOut()));
      }
    }, 40);
  });
}

test('after a submit, an idle session gets save-state then /compact injected', { skip: !pty }, async () => {
  const { term, out } = spawnWrapped();
  try {
    await waitFor(out, 'mock-agent ready', 4000);
    term.write('do the thing\r');
    await waitFor(out, 'GOT[SAVESTATE_MARKER', 6000);
    await waitFor(out, 'GOT[/compact', 6000);
  } finally {
    term.kill();
  }
});

test('nothing is injected before the first real submit', { skip: !pty }, async () => {
  const { term, out } = spawnWrapped();
  try {
    await waitFor(out, 'mock-agent ready', 4000);
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!out().includes('GOT[SAVESTATE_MARKER'),
      'save prompt must not be injected into a session the user never used\n--- output ---\n' + out());
  } finally {
    term.kill();
  }
});

test('unsent pending input defers compaction', { skip: !pty }, async () => {
  const { term, out } = spawnWrapped();
  try {
    await waitFor(out, 'mock-agent ready', 4000);
    term.write('half typed note');
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!out().includes('GOT[SAVESTATE_MARKER'),
      'save prompt must not be injected while a draft is pending\n--- output ---\n' + out());
  } finally {
    term.kill();
  }
});
