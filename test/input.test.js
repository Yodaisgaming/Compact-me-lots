'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classify, InputTracker } = require('../lib/input');

test('Enter variants are submits', () => {
  assert.equal(classify('\r'), 'submit');
  assert.equal(classify('\n'), 'submit');
  assert.equal(classify('\r\n'), 'submit');
});

test('plain text and backspace', () => {
  assert.equal(classify('hello'), 'text');
  assert.equal(classify('a'), 'text');
  assert.equal(classify('\x7f'), 'backspace');
  assert.equal(classify('\b'), 'backspace');
});

test('mouse, focus and navigation sequences are ignored', () => {
  assert.equal(classify('\x1b[M !!'), 'ignore');
  assert.equal(classify('\x1b[<0;12;7M'), 'ignore');
  assert.equal(classify('\x1b[I'), 'ignore');
  assert.equal(classify('\x1b[O'), 'ignore');
  assert.equal(classify('\x1b[C'), 'ignore');
  assert.equal(classify('\x1b[D'), 'ignore');
});

test('bracketed paste and mixed bursts count as composer input', () => {
  assert.equal(classify('\x1b[200~pasted text\x1b[201~'), 'paste');
  assert.equal(classify('line1\nline2'), 'paste');
});

test('typing does not bump submit time; Enter does', () => {
  const t = new InputTracker(1000);
  t.note('h', 2000);
  t.note('i', 2100);
  assert.equal(t.lastSubmitAt, 1000);
  assert.equal(t.pendingInput, true);
  t.note('\r', 3000);
  assert.equal(t.lastSubmitAt, 3000);
  assert.equal(t.pendingInput, false);
});

test('backspace clears pending back to empty', () => {
  const t = new InputTracker(0);
  t.note('a', 1);
  t.note('b', 2);
  assert.equal(t.pendingInput, true);
  t.note('\x7f', 3);
  t.note('\x7f', 4);
  assert.equal(t.pendingInput, false);
});

test('paste marks pending dirty until submit; backspace does not clear it', () => {
  const t = new InputTracker(0);
  t.note('\x1b[200~stuff\x1b[201~', 1);
  assert.equal(t.pendingInput, true);
  t.note('\x7f', 2);
  assert.equal(t.pendingInput, true);
  t.note('\r', 3);
  assert.equal(t.pendingInput, false);
});

test('mouse movement changes nothing (no pending, no seq bump)', () => {
  const t = new InputTracker(0);
  const seq = t.seq;
  t.note('\x1b[<0;40;10M', 5);
  assert.equal(t.pendingInput, false);
  assert.equal(t.seq, seq);
  assert.equal(t.lastSubmitAt, 0);
});

test('genuine input bumps seq (for delayed-submit abort)', () => {
  const t = new InputTracker(0);
  const seq = t.seq;
  t.note('x', 1);
  assert.equal(t.seq, seq + 1);
});
