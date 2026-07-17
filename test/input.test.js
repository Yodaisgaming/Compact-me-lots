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

test('a chunk merging text with its Enter still submits and clears pending', () => {
  const t = new InputTracker(0);
  assert.equal(t.note('deploy the fix\r', 500), 'submit');
  assert.equal(t.lastSubmitAt, 500);
  assert.equal(t.pendingInput, false);
});

test('a merged CRLF submit behaves the same', () => {
  const t = new InputTracker(0);
  assert.equal(t.note('hello\r\n', 600), 'submit');
  assert.equal(t.pendingInput, false);
});

test('a bracketed paste ending with Enter submits instead of wedging', () => {
  const t = new InputTracker(0);
  assert.equal(t.note('\x1b[200~two\nlines\x1b[201~\r', 700), 'submit');
  assert.equal(t.pendingInput, false);
});

test('text after an embedded Enter stays pending as a fresh draft', () => {
  const t = new InputTracker(0);
  assert.equal(t.note('first\rsecond', 900), 'submit');
  assert.equal(t.lastSubmitAt, 900);
  assert.equal(t.pendingInput, true);
});

test('a focus event fused to typed text does not swallow the text or the Enter', () => {
  const t = new InputTracker(0);
  assert.equal(t.note('\x1b[Ido the thing\r', 400), 'submit');
  assert.equal(t.pendingInput, false);
  assert.equal(t.hasSubmitted, true);
});

test('mode-set sequences fused before text are stripped individually', () => {
  const t = new InputTracker(0);
  t.note('\x1b[?1004hhello', 300);
  assert.equal(t.pendingChars, 5);
  assert.equal(t.pendingInput, true);
});

test('escape sequences after text are split without dirtying known input', () => {
  const t = new InputTracker(0);
  t.note('hello\x1b[I', 300);
  assert.equal(t.pendingChars, 5);
  assert.equal(t.pendingDirty, false);
});

test('OSC, parameterized SS3 and X10 mouse consume only their own bytes', () => {
  const t = new InputTracker(0);
  t.note('\x1b]10;rgb:00/00/00\x1b\\a', 100);
  t.note('\x1bO1;2Pb', 200);
  t.note('\x1b[M !!c', 300);
  assert.equal(t.pendingChars, 3);
  assert.equal(t.pendingDirty, false);
});

test('a bracketed paste stays a paste when split across stdin chunks', () => {
  const t = new InputTracker(0);
  t.note('\x1b[200~first', 100);
  t.note('\nsecond\x1b[201~', 200);
  assert.equal(t.hasSubmitted, false);
  assert.equal(t.pendingInput, true);
});

test('split bracketed-paste markers preserve embedded newlines', () => {
  const t = new InputTracker(0);
  t.note('\x1b[20', 100);
  t.note('0~first\nsecond\x1b[20', 200);
  t.note('1~', 300);
  assert.equal(t.hasSubmitted, false);
  assert.equal(t.pendingInput, true);
});

test('win32-input-mode keydowns decode to text and submit (nested ConPTY)', () => {
  const t = new InputTracker(0);
  t.note('\x1b[68;32;100;1;0;1_\x1b[68;32;100;0;0;1_', 100);
  assert.equal(t.pendingChars, 1);
  assert.equal(t.note('\x1b[13;28;13;1;0;1_', 200), 'submit');
  assert.equal(t.hasSubmitted, true);
  assert.equal(t.lastSubmitAt, 200);
  assert.equal(t.pendingInput, false);
});

test('a win32-input-mode sequence can span stdin chunks', () => {
  const t = new InputTracker(0);
  t.note('\x1b[68;32;100;', 100);
  t.note('1;0;1_', 200);
  assert.equal(t.pendingChars, 1);
  assert.equal(t.pendingDirty, false);
});

test('win32-input-mode backspace decrements and key-ups are ignored', () => {
  const t = new InputTracker(0);
  t.note('\x1b[68;32;100;1;0;1_', 100);
  t.note('\x1b[8;14;8;1;0;1_', 150);
  assert.equal(t.pendingInput, false);
  const seq = t.seq;
  t.note('\x1b[68;32;100;0;0;1_', 160);
  assert.equal(t.seq, seq);
});

test('win32-input-mode pure modifier keydowns change nothing', () => {
  const t = new InputTracker(0);
  t.note('\x1b[16;42;0;1;0;1_', 100);
  assert.equal(t.pendingInput, false);
  assert.equal(t.hasSubmitted, false);
});

test('win32-input-mode modified Enter is composer text, not submit', () => {
  const t = new InputTracker(0);
  t.note('\x1b[13;28;13;1;16;1_', 100);
  assert.equal(t.hasSubmitted, false);
  assert.equal(t.pendingInput, true);
});

test('win32-input-mode honors omitted protocol parameters and virtual keys', () => {
  const t = new InputTracker(0);
  t.note('\x1b[65;;97;1;0;1;2_', 100);
  assert.equal(t.pendingChars, 0);
  t.note('\x1b[65;;97;1_', 200);
  assert.equal(t.pendingChars, 1);
  assert.equal(t.note('\x1b[13;;;1_', 300), 'submit');
  assert.equal(t.hasSubmitted, true);
});

test('a standalone escape fused before Enter does not swallow the submit', () => {
  const t = new InputTracker(0);
  assert.equal(t.note('\x1b\r', 400), 'submit');
  assert.equal(t.hasSubmitted, true);
});

test('a doubled escape does not expose the following navigation bytes as text', () => {
  const t = new InputTracker(0);
  t.note('\x1b\x1b[A', 400);
  assert.equal(t.pendingChars, 0);
  assert.equal(t.pendingDirty, true);
});

test('hasSubmitted starts false and only a real Enter sets it', () => {
  const t = new InputTracker(0);
  t.note('abc', 1);
  assert.equal(t.hasSubmitted, false);
  t.note('\r', 2);
  assert.equal(t.hasSubmitted, true);
});

test('history and overlay keys classify as nav', () => {
  assert.equal(classify('\x1b[A'), 'nav');
  assert.equal(classify('\x1b[B'), 'nav');
  assert.equal(classify('\x1b[5~'), 'nav');
  assert.equal(classify('\x1b[6~'), 'nav');
  assert.equal(classify('\x1b[Z'), 'nav');
  assert.equal(classify('\x1bOA'), 'nav');
  assert.equal(classify('\x12'), 'nav');
  assert.equal(classify('\t'), 'nav');
  assert.equal(classify('\x1b'), 'nav');
  assert.equal(classify('\x1bm'), 'nav');
});

test('terminal auto-responses stay ignored, not nav', () => {
  assert.equal(classify('\x1b[?1;2c'), 'ignore');
  assert.equal(classify('\x1b[12;34R'), 'ignore');
  assert.equal(classify('\x1b[H'), 'ignore');
  assert.equal(classify('\x1b[F'), 'ignore');
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

test('win32-input-mode nav keys mark dirty (arrows, PgUp/PgDn, Tab, Esc, Ctrl-chords)', () => {
  for (const seq of ['\x1b[38;72;0;1;0;1_', '\x1b[33;73;0;1;0;1_', '\x1b[9;15;9;1;0;1_', '\x1b[27;1;27;1;0;1_', '\x1b[82;19;18;1;8;1_']) {
    const t = new InputTracker(0);
    t.note(seq, 1);
    assert.equal(t.pendingChars, 0, seq);
    assert.equal(t.pendingDirty, true, seq);
  }
});

test('win32-input-mode cursor-only and modifier keys stay ignored', () => {
  for (const seq of ['\x1b[37;75;0;1;0;1_', '\x1b[39;77;0;1;0;1_', '\x1b[16;42;0;1;0;1_']) {
    const t = new InputTracker(0);
    t.note(seq, 1);
    assert.equal(t.pendingInput, false, seq);
  }
});

test('a win32-input-mode leading space marks dirty (voice push-to-talk)', () => {
  const t = new InputTracker(0);
  t.note('\x1b[32;57;32;1;0;1_', 1);
  assert.equal(t.pendingChars, 0);
  assert.equal(t.pendingDirty, true);
});
