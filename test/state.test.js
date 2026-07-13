'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createMachine, decide, reset } = require('../lib/state');

const cfg = {
  idleMs: 240000,
  graceMs: 1800000,
  sizeGate: 100000,
  settleQuietMs: 8000,
  minTurnMs: 10000,
  maxPhaseMs: 300000,
  useTranscript: true,
};

const genericCfg = Object.assign({}, cfg, { useTranscript: false, sizeGate: 0 });

function ctx(over) {
  return Object.assign({
    contextTokens: 200000,
    settled: true,
    realIdleMs: 250000,
    userIdleMs: 250000,
    ptyQuietMs: 10000,
    pendingInput: false,
    lastAssistantAt: 1000,
    hasTranscript: true,
    hasUserSubmit: true,
    now: 1000000,
  }, over);
}

test('fires save when idle, settled, big and quiet', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx(), cfg), 'save');
  assert.equal(m.phase, 'saving');
});

test('pending unsent input defers', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx({ pendingInput: true }), cfg), 'none');
  assert.equal(m.phase, 'watch');
});

test('recent submit defers even when the agent has been idle a while', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx({ userIdleMs: 5000 }), cfg), 'none');
});

test('a mid-turn (unsettled) session is never interrupted', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx({ settled: false }), cfg), 'none');
});

test('small context is left alone', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx({ contextTokens: 50000 }), cfg), 'none');
});

test('Claude mode without a transcript never fires (fresh/empty session)', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx({ hasTranscript: false, contextTokens: null }), cfg), 'none');
  assert.equal(m.phase, 'watch');
});

test('Claude mode with an unknown context size defers', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx({ contextTokens: null }), cfg), 'none');
});

test('generic mode never fires before the first real submit', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx({ hasTranscript: false, contextTokens: null, hasUserSubmit: false }), genericCfg), 'none');
});

test('generic mode fires after a real submit', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx({ hasTranscript: false, contextTokens: null, hasUserSubmit: true }), genericCfg), 'save');
});

test('abandoned (idle past grace) is left alone', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx({ realIdleMs: 2000000 }), cfg), 'none');
});

test('save advances to compact only after a NEW completed turn', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx({ now: 1000000 }), cfg), 'save');
  assert.equal(decide(m, ctx({ now: 1015000, lastAssistantAt: 1000 }), cfg), 'none');
  assert.equal(decide(m, ctx({ now: 1016000, lastAssistantAt: 1012000 }), cfg), 'compact');
  assert.equal(m.phase, 'compacting');
});

test('save cannot fall back to terminal quiet when its transcript disappears', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx({ now: 1000000 }), cfg), 'save');
  assert.equal(decide(m, ctx({ now: 1015000, hasTranscript: false, lastAssistantAt: null }), cfg), 'none');
  assert.equal(m.phase, 'saving');
});

test('save requires a timestamp for the new transcript turn', () => {
  const m = createMachine();
  assert.equal(decide(m, ctx({ now: 1000000 }), cfg), 'save');
  assert.equal(decide(m, ctx({ now: 1015000, lastAssistantAt: null }), cfg), 'none');
  assert.equal(m.phase, 'saving');
});

test('compacting settles to done after the min-turn floor', () => {
  const m = createMachine();
  m.phase = 'compacting';
  m.compactAt = 1000000;
  assert.equal(decide(m, ctx({ now: 1005000 }), cfg), 'none');
  assert.equal(decide(m, ctx({ now: 1011000 }), cfg), 'done');
  assert.equal(m.phase, 'done');
});

test('a phase that never settles aborts at max-phase', () => {
  const m = createMachine();
  m.phase = 'saving';
  m.savePromptAt = 1000000;
  assert.equal(decide(m, ctx({ now: 1000000 + 300001 }), cfg), 'abort');
  assert.equal(m.phase, 'done');
});

test('done stays quiet; reset re-arms', () => {
  const m = createMachine();
  m.phase = 'done';
  assert.equal(decide(m, ctx(), cfg), 'none');
  reset(m);
  assert.equal(m.phase, 'watch');
  assert.equal(decide(m, ctx(), cfg), 'save');
});
