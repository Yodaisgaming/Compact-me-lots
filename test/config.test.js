'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildConfig } = require('../lib/config');

test('command after -- is separated from flags', () => {
  const { command } = buildConfig(['--verbose', '--', 'claude', '--foo'], {});
  assert.deepEqual(command, ['claude', '--foo']);
});

test('flags override defaults and convert seconds to ms', () => {
  const { config } = buildConfig(['--idle', '30', '--size-gate', '5000', '--', 'claude'], {});
  assert.equal(config.idleMs, 30000);
  assert.equal(config.sizeGate, 5000);
});

test('help flag is detected and stripped from config', () => {
  const { help } = buildConfig(['--help'], {});
  assert.equal(help, true);
});

test('CML_* environment variables are read', () => {
  const { config } = buildConfig(['--', 'claude'], { CML_IDLE_MS: '99000', CML_NO_TRANSCRIPT: '1' });
  assert.equal(config.idleMs, 99000);
  assert.equal(config.useTranscript, false);
});

test('explicit flags win over environment', () => {
  const { config } = buildConfig(['--idle', '10', '--', 'claude'], { CML_IDLE_MS: '99000' });
  assert.equal(config.idleMs, 10000);
});

test('no command yields an empty command array', () => {
  const { command } = buildConfig(['--verbose'], {});
  assert.deepEqual(command, []);
});

test('compact-cmd and save-prompt pass through verbatim', () => {
  const { config } = buildConfig(['--compact-cmd', '/squash', '--save-prompt', 'save now', '--', 'x'], {});
  assert.equal(config.compactCmd, '/squash');
  assert.equal(config.savePrompt, 'save now');
});
