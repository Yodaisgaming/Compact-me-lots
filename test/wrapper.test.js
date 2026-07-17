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
