'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { slugCandidates, cwdMarker, fileMatchesCwd, readState } = require('../lib/transcript');

// Fixtures mirror Claude Code's real JSONL: assistant records carry
// message.stop_reason + message.usage; user records carry tool results or user
// text; many non-message record types are interleaved.
function tmpFile(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-'));
  const f = path.join(dir, 'session.jsonl');
  fs.writeFileSync(f, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
const asst = (stop, tokens) => ({
  type: 'assistant',
  timestamp: '2026-07-11T10:00:00.000Z',
  message: {
    role: 'assistant',
    stop_reason: stop,
    usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0, output_tokens: 5 },
  },
});
const usr = () => ({ type: 'user', timestamp: '2026-07-11T10:00:01.000Z', message: { role: 'user' } });
const meta = (t) => ({ type: t });

test('slug: each :, \\, / and . becomes its own dash', () => {
  assert.equal(slugCandidates('C:\\Users\\dev\\my-app')[0], 'C--Users-dev-my-app');
  assert.equal(slugCandidates('C:\\Users\\dev\\.config\\tool')[0], 'C--Users-dev--config-tool');
});

test('slug: the primary candidate flattens underscores like Claude Code does', () => {
  const cands = slugCandidates('C:\\dev\\my_app');
  assert.equal(cands[0], 'C--dev-my-app');
  assert.ok(cands.includes('C--dev-my_app'));
});

test('a transcript is only accepted when its head names the same cwd', () => {
  const f = tmpFile([{ type: 'user', cwd: 'C:\\dev\\proj', message: { role: 'user' } }]);
  assert.equal(fileMatchesCwd(f, cwdMarker('C:\\dev\\proj')), true);
  assert.equal(fileMatchesCwd(f, cwdMarker('C:\\dev\\other')), false);
});

test('cwd marker matching preserves JSON escaping', () => {
  const cwd = 'C:\\dev\\a"b';
  const f = tmpFile([{ type: 'user', cwd, message: { role: 'user' } }]);
  assert.equal(fileMatchesCwd(f, cwdMarker(cwd)), true);
});

test('settled TRUE when the last message record is an assistant end_turn', () => {
  const f = tmpFile([meta('mode'), asst('tool_use', 200000), usr(), asst('end_turn', 210000), meta('last-prompt'), meta('ai-title')]);
  const s = readState(f);
  assert.equal(s.settled, true);
  assert.equal(s.contextTokens, 210000);
});

test('settled FALSE when the last assistant is awaiting a tool (tool_use)', () => {
  const f = tmpFile([asst('end_turn', 100000), usr(), asst('tool_use', 205000)]);
  assert.equal(readState(f).settled, false);
});

test('settled FALSE when a user record trails a completed turn', () => {
  const f = tmpFile([asst('end_turn', 150000), usr(), usr(), usr()]);
  assert.equal(readState(f).settled, false);
});

test('non-message meta records after end_turn do not unsettle it', () => {
  const f = tmpFile([asst('end_turn', 120000), meta('file-history-snapshot'), meta('mode'), meta('permission-mode')]);
  assert.equal(readState(f).settled, true);
});

test('contextTokens = input + cache_read + cache_creation of the last assistant', () => {
  const f = tmpFile([asst('end_turn', 175000)]);
  assert.equal(readState(f).contextTokens, 175000);
});

test('readState returns null when there are no message records', () => {
  const f = tmpFile([meta('mode'), meta('permission-mode')]);
  assert.equal(readState(f), null);
});
