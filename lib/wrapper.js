'use strict';

const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { InputTracker } = require('./input');
const { createMachine, decide, reset } = require('./state');
const transcript = require('./transcript');

function log(cfg, msg) {
  if (cfg.verbose) process.stderr.write('[compact-me-lots] ' + msg + '\n');
}

// Spawns `command` in a pseudo-terminal, wires the user's terminal straight
// through to it, and runs the idle-compaction sweep on the side. Injected
// writes go to the child directly and are never fed through the input tracker,
// so the tool's own writes are not mistaken for the user typing.
function run(command, cfg) {
  const shell = command[0];
  const args = command.slice(1);
  const cwd = process.cwd();
  const startedAt = Date.now();

  const child = pty.spawn(shell, args, {
    name: process.env.TERM || 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 30,
    cwd,
    env: process.env,
  });

  const input = new InputTracker(Date.now());
  const machine = createMachine();
  let lastOutputAt = Date.now();
  let injecting = false;
  let transcriptFile = null;

  child.onData((data) => {
    lastOutputAt = Date.now();
    process.stdout.write(data);
  });

  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    const data = String(chunk);
    const kind = input.note(data, Date.now());
    if (kind === 'submit') reset(machine);
    child.write(data);
  });

  process.stdout.on('resize', () => {
    try { child.resize(process.stdout.columns || 80, process.stdout.rows || 30); } catch { /* ignore */ }
  });

  function injectSubmit(body) {
    injecting = true;
    child.write(body);
    const seqAt = input.seq;
    setTimeout(() => {
      if (input.seq === seqAt) child.write('\r');
      injecting = false;
    }, cfg.injectDelayMs);
  }

  let warnedNoTranscript = false;
  const timer = setInterval(() => {
    if (injecting) return;
    if (input.submitCount === 0) return;
    const now = Date.now();
    const ptyQuietMs = now - lastOutputAt;

    let ts = null;
    if (cfg.useTranscript) {
      if (!transcriptFile) transcriptFile = transcript.findTranscript(cwd, startedAt);
      if (transcriptFile) ts = transcript.readState(transcriptFile);
      if (!ts) {
        if (!warnedNoTranscript && now - startedAt > 60000) {
          warnedNoTranscript = true;
          log(cfg, 'no matching transcript found; staying inactive (pass --no-transcript for non-Claude CLIs)');
        }
        return;
      }
    }
    const hasTranscript = !!ts;

    const ctx = {
      contextTokens: hasTranscript ? ts.contextTokens : null,
      settled: hasTranscript ? ts.settled : ptyQuietMs >= cfg.settleQuietMs,
      realIdleMs: hasTranscript && ts.lastAssistantAt ? now - ts.lastAssistantAt : now - lastOutputAt,
      userIdleMs: now - input.lastSubmitAt,
      ptyQuietMs,
      pendingInput: input.pendingInput,
      lastAssistantAt: hasTranscript ? ts.lastAssistantAt : null,
      hasTranscript,
      now,
    };

    const action = decide(machine, ctx, cfg);
    if (action === 'save') {
      log(cfg, 'idle and cache still warm -> saving state');
      injectSubmit(cfg.savePrompt);
    } else if (action === 'compact') {
      log(cfg, 'save turn finished -> compacting');
      injectSubmit(cfg.compactCmd);
    } else if (action === 'done') {
      log(cfg, 'compaction banked; waiting for you to return');
    } else if (action === 'abort') {
      log(cfg, 'a phase never settled -> aborted this cycle');
    }
  }, cfg.sweepMs);

  if (timer.unref) timer.unref();

  child.onExit(({ exitCode }) => {
    clearInterval(timer);
    if (stdin.isTTY) { try { stdin.setRawMode(false); } catch { /* ignore */ } }
    stdin.pause();
    process.exit(exitCode || 0);
  });
}

module.exports = { run };
