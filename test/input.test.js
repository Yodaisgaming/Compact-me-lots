'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classify, InputTracker, decodeWin32Input } = require('../lib/input');

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

test('mouse, focus and terminal responses are ignored', () => {
  assert.equal(classify('\x1b[M !!'), 'ignore');
  assert.equal(classify('\x1b[<0;12;7M'), 'ignore');
  assert.equal(classify('\x1b[I'), 'ignore');
  assert.equal(classify('\x1b[O'), 'ignore');
  assert.equal(classify('\x1b[?1;2c'), 'ignore');
  assert.equal(classify('\x1b[12;34R'), 'ignore');
  assert.equal(classify('\x1b]11;rgb:1e/1e/2e\x07'), 'ignore');
  assert.equal(classify('\x1b]\x07'), 'ignore');
  assert.equal(classify('\x1b]\x1b\\'), 'ignore');
});

test('history/nav-capable keys classify as nav', () => {
  assert.equal(classify('\x1b[A'), 'nav');
  assert.equal(classify('\x1b[B'), 'nav');
  assert.equal(classify('\x1b[C'), 'nav');
  assert.equal(classify('\x1b[D'), 'nav');
  assert.equal(classify('\x1b[5~'), 'nav');
  assert.equal(classify('\x1b[Z'), 'nav');
  assert.equal(classify('\x1bOA'), 'nav');
  assert.equal(classify('\x12'), 'nav');
  assert.equal(classify('\t'), 'nav');
  assert.equal(classify('\x1b'), 'nav');
  assert.equal(classify('\x1bm'), 'nav');
  assert.equal(classify('\x1b[A\x1b[A'), 'nav');
});

test('bracketed paste and mixed bursts count as composer input', () => {
  assert.equal(classify('\x1b[200~pasted text\x1b[201~'), 'paste');
  assert.equal(classify('line1\nline2'), 'paste');
});

test('a chunk ending in Enter is a submit (merged text+Enter, v0.1.0 Bug 2)', () => {
  assert.equal(classify('hello world\r'), 'submit');
  assert.equal(classify('hello\n'), 'submit');
  assert.equal(classify('line1\nline2\r'), 'submit');
  assert.equal(classify('\x1b[A\r'), 'submit');
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

test('merged text+Enter chunk does not wedge the tracker (v0.1.0 Bug 2)', () => {
  const t = new InputTracker(0);
  t.note('run the tests\r', 1000);
  assert.equal(t.pendingInput, false);
  assert.equal(t.lastSubmitAt, 1000);
  assert.equal(t.submitCount, 1);
});

test('nav keys mark pending dirty until submit (history recall is untrackable)', () => {
  const t = new InputTracker(0);
  t.note('\x1b[A', 1);
  assert.equal(t.pendingInput, true);
  t.note('\x7f', 2);
  assert.equal(t.pendingInput, true);
  t.note('\r', 3);
  assert.equal(t.pendingInput, false);
});

test('a bare leading space marks dirty (voice push-to-talk), spaces mid-draft do not', () => {
  const t = new InputTracker(0);
  t.note(' ', 1);
  assert.equal(t.pendingDirty, true);
  t.note('\r', 2);
  const u = new InputTracker(0);
  u.note('a', 1);
  u.note(' ', 2);
  assert.equal(u.pendingDirty, false);
  assert.equal(u.pendingChars, 2);
});

test('win32-input-mode records decode to chars, keys and Enter (ConPTY)', () => {
  assert.equal(decodeWin32Input('\x1b[72;35;104;1;0;1_\x1b[72;35;104;0;0;1_'), 'h');
  assert.equal(decodeWin32Input('\x1b[13;28;13;1;0;1_'), '\r');
  assert.equal(decodeWin32Input('\x1b[38;72;0;1;0;1_'), '\x1b[A');
  assert.equal(decodeWin32Input('\x1b[65;30;97;1;0;3_'), 'aaa');
  assert.equal(decodeWin32Input('plain text'), 'plain text');
  assert.equal(classify('\x1b[72;35;104;1;0;1_\x1b[105;23;105;1;0;1_'), 'text');
  assert.equal(classify('\x1b[13;28;13;1;0;1_'), 'submit');
  assert.equal(classify('\x1b[38;72;0;1;0;1_'), 'nav');
});

test('submitCount starts at zero and counts real submits only', () => {
  const t = new InputTracker(0);
  assert.equal(t.submitCount, 0);
  t.note('typing', 1);
  t.note('\x1b[A', 2);
  assert.equal(t.submitCount, 0);
  t.note('\r', 3);
  t.note('done\r', 4);
  assert.equal(t.submitCount, 2);
});
