'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { InputTracker } = require('../lib/input');
const { createMachine, decide, reset } = require('../lib/state');

let makeInjector = null;
try {
  makeInjector = require('../lib/wrapper').makeInjector;
} catch {
  makeInjector = null;
}

function setup() {
  const writes = [];
  const input = new InputTracker(0);
  const machine = createMachine();
  machine.phase = 'saving';
  const injector = makeInjector({
    write: (d) => writes.push(d),
    input,
    machine,
    log: () => {},
    injectDelayMs: 20,
  });
  return { writes, input, machine, injector };
}

test('an undisturbed injection sends its Enter and keeps the phase', { skip: !makeInjector }, async () => {
  const { writes, machine, injector } = setup();
  injector.submit('SAVE');
  assert.equal(injector.injecting, true);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(writes, ['SAVE', '\r']);
  assert.equal(machine.phase, 'saving');
  assert.equal(injector.injecting, false);
});

test('input during the injection window cancels the Enter AND kills the cycle', { skip: !makeInjector }, async () => {
  const { writes, input, machine, injector } = setup();
  injector.submit('SAVE');
  input.note('\x1b[?1;2', 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(writes, ['SAVE']);
  assert.equal(machine.phase, 'done');
});

test('a real submit during the injection window wins: cycle stays re-armed', { skip: !makeInjector }, async () => {
  const { writes, input, machine, injector } = setup();
  injector.submit('SAVE');
  input.note('\r', 1);
  reset(machine);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(writes, ['SAVE']);
  assert.equal(machine.phase, 'watch');
});

function tmpTranscript(name, lines) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('transcript mode: swallowed Enter is retried, then confirmed by the appended user record', { skip: !makeInjector }, async () => {
  const fs = require('fs');
  const file = tmpTranscript('wrapper-retry.jsonl', []);
  try {
    const { writes, machine, injector } = setup();
    let size = 0;
    const inj = makeInjector({
      write: (d) => {
        writes.push(d);
        if (writes.filter((w) => w === '\r').length === 2) {
          fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'SAVE' } }) + '\n');
          size = fs.statSync(file).size;
        }
      },
      input: new InputTracker(0),
      machine,
      log: () => {},
      injectDelayMs: 10,
      verifyDelayMs: 30,
      stat: () => ({ file, size: size, mtimeMs: 1 }),
    });
    machine.phase = 'saving';
    inj.submit('SAVE');
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(writes.filter((w) => w === '\r').length, 2);
    assert.equal(machine.phase, 'saving');
    assert.equal(inj.injecting, false);
  } finally {
    try { require('fs').unlinkSync(file) } catch {}
  }
});

test('transcript mode: a foreign turn aborts the cycle instead of submitting', { skip: !makeInjector }, async () => {
  const file = tmpTranscript('wrapper-foreign.jsonl', [{ type: 'user', message: { content: 'unrelated notification' } }]);
  try {
    const writes = [];
    const machine = createMachine();
    machine.phase = 'saving';
    let size = 0;
    const inj = makeInjector({
      write: (d) => writes.push(d),
      input: new InputTracker(0),
      machine,
      log: () => {},
      injectDelayMs: 10,
      verifyDelayMs: 30,
      stat: () => ({ file, size: (size += 10), mtimeMs: size }),
    });
    inj.submit('SAVE');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(writes, ['SAVE']);
    assert.equal(machine.phase, 'done');
    assert.equal(inj.injecting, false);
  } finally {
    try { require('fs').unlinkSync(file) } catch {}
  }
});

test('transcript mode: three dead Enters give up and kill the cycle', { skip: !makeInjector }, async () => {
  const file = tmpTranscript('wrapper-dead.jsonl', []);
  try {
    const writes = [];
    const machine = createMachine();
    machine.phase = 'saving';
    const inj = makeInjector({
      write: (d) => writes.push(d),
      input: new InputTracker(0),
      machine,
      log: () => {},
      injectDelayMs: 10,
      verifyDelayMs: 30,
      stat: () => ({ file, size: 0, mtimeMs: 1 }),
    });
    inj.submit('SAVE');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(writes.filter((w) => w === '\r').length, 3);
    assert.equal(machine.phase, 'done');
    assert.equal(inj.injecting, false);
  } finally {
    try { require('fs').unlinkSync(file) } catch {}
  }
});

test('transcript mode: rotation to a new session file aborts instead of retrying', { skip: !makeInjector }, async () => {
  const fileA = tmpTranscript('wrapper-rot-a.jsonl', []);
  const fileB = tmpTranscript('wrapper-rot-b.jsonl', []);
  try {
    const writes = [];
    const machine = createMachine();
    machine.phase = 'saving';
    let calls = 0;
    const inj = makeInjector({
      write: (d) => writes.push(d),
      input: new InputTracker(0),
      machine,
      log: () => {},
      injectDelayMs: 10,
      verifyDelayMs: 30,
      stat: () => (++calls === 1 ? { file: fileA, size: 0, mtimeMs: 1 } : { file: fileB, size: 0, mtimeMs: 1 }),
    });
    inj.submit('SAVE');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(writes, ['SAVE']);
    assert.equal(machine.phase, 'done');
  } finally {
    for (const f of [fileA, fileB]) { try { require('fs').unlinkSync(f) } catch {} }
  }
});

test('a JSON-escaped body (quotes, newline) is still confirmed as delivered', { skip: !makeInjector }, () => {
  const transcript = require('../lib/transcript');
  const body = 'remember "alpha"\nnext';
  const file = tmpTranscript('wrapper-escaped.jsonl', [
    { type: 'user', message: { content: body } },
  ]);
  try {
    assert.equal(transcript.appendedHasSubmit(file, 0, body), true);
    assert.equal(transcript.appendedHasSubmit(file, 0, 'something else'), false);
  } finally {
    try { require('fs').unlinkSync(file) } catch {}
  }
});

test('sidechain and assistant records never count as delivery', { skip: !makeInjector }, () => {
  const transcript = require('../lib/transcript');
  const file = tmpTranscript('wrapper-sidechain.jsonl', [
    { type: 'user', isSidechain: true, message: { content: 'SAVE' } },
    { type: 'assistant', message: { content: 'SAVE' } },
  ]);
  try {
    assert.equal(transcript.appendedHasSubmit(file, 0, 'SAVE'), false);
  } finally {
    try { require('fs').unlinkSync(file) } catch {}
  }
});

test('a dead cycle never advances to compact until reset', { skip: !makeInjector }, () => {
  const machine = createMachine();
  machine.phase = 'done';
  const ctx = {
    contextTokens: null, settled: true, realIdleMs: 10_000, userIdleMs: 10_000,
    ptyQuietMs: 10_000, pendingInput: false, lastAssistantAt: null,
    hasTranscript: false, hasUserSubmit: true, now: 100_000,
  };
  const cfg = { useTranscript: false, idleMs: 100, graceMs: 1_000_000, sizeGate: 0, settleQuietMs: 100, minTurnMs: 100, maxPhaseMs: 1_000_000 };
  assert.equal(decide(machine, ctx, cfg), 'none');
  assert.equal(decide(machine, ctx, cfg), 'none');
});
