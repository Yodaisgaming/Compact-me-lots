'use strict';

const fs = require('fs');
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
const CR_QUIET_WAIT_MAX_MS = 5_000;
const VERIFY_DELAY_MS = 1_500;
const MAX_SUBMIT_ATTEMPTS = 3;

function statsDiffer(a, b) {
  if (!a || !b) return true;
  return a.file !== b.file || a.size !== b.size || a.mtimeMs !== b.mtimeMs;
}

function makeInjector(io) {
  const stat = io.stat || (() => null);
  const quietMs = io.quietMs || (() => Infinity);
  const crQuietMs = io.crQuietMs || 0;
  const verifyDelayMs = io.verifyDelayMs || VERIFY_DELAY_MS;

  const injector = {
    injecting: false,
    submit(body) {
      injector.injecting = true;
      io.write(body);
      const seqAt = io.input.seq;
      const phaseAt = io.machine.phase;
      const t0 = stat();

      const die = (msg) => {
        if (io.machine.phase === phaseAt) io.machine.phase = 'done';
        io.log(msg);
        injector.injecting = false;
      };
      const userWon = () => {
        if (io.input.seq === seqAt) return false;
        if (io.machine.phase === phaseAt) {
          io.machine.phase = 'done';
          io.log('input arrived during injection -> cycle aborted');
        }
        injector.injecting = false;
        return true;
      };

      const sendCr = (attempt, startAt) => {
        if (userWon()) return;
        if (t0 && statsDiffer(t0, stat())) {
          const t1 = stat();
          if (t1 && t1.file === t0.file && transcript.appendedHasSubmit(t1.file, t0.size, body)) {
            injector.injecting = false;
            return;
          }
          die('a foreign turn started before the injected Enter -> cycle aborted');
          return;
        }
        if (quietMs() < crQuietMs && Date.now() - startAt < CR_QUIET_WAIT_MAX_MS) {
          setTimeout(() => sendCr(attempt, startAt), 100);
          return;
        }
        io.write('\r');
        if (io.machine.phase === phaseAt) {
          if (phaseAt === 'saving') io.machine.savePromptAt = Date.now();
          else if (phaseAt === 'compacting') io.machine.compactAt = Date.now();
        }
        if (!t0) {
          injector.injecting = false;
          return;
        }
        setTimeout(() => verify(attempt), verifyDelayMs);
      };

      const verify = (attempt) => {
        if (userWon()) return;
        const t1 = stat();
        if (statsDiffer(t0, t1)) {
          if (t1 && t1.file === t0.file && transcript.appendedHasSubmit(t1.file, t0.size, body)) {
            io.log('injected submit confirmed');
            injector.injecting = false;
            return;
          }
          die('transcript moved without our submit -> cycle aborted');
          return;
        }
        if (attempt >= MAX_SUBMIT_ATTEMPTS) {
          die('injected submit never landed after ' + attempt + ' attempts -> cycle aborted');
          return;
        }
        io.log('injected Enter did not land -> retrying (' + attempt + ')');
        sendCr(attempt + 1, Date.now());
      };

      setTimeout(() => sendCr(1, Date.now()), io.injectDelayMs);
    },
  };
  return injector;
}

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

  const injector = makeInjector({
    write: (d) => child.write(d),
    input,
    machine,
    log: (msg) => log(cfg, msg),
    injectDelayMs: cfg.injectDelayMs,
    crQuietMs: cfg.settleQuietMs,
    quietMs: () => Date.now() - lastOutputAt,
    stat: () => {
      if (!cfg.useTranscript) return null;
      const f = transcript.findTranscript(cwd, startedAt) || transcriptFile;
      if (!f) return null;
      try {
        const st = fs.statSync(f);
        return { file: f, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        return null;
      }
    },
  });
  const injectSubmit = injector.submit;

  const timer = setInterval(() => {
    if (injector.injecting) return;
    const now = Date.now();
    const ptyQuietMs = now - lastOutputAt;

    let ts = null;
    if (cfg.useTranscript) {
      transcriptFile = transcript.findTranscript(cwd, startedAt) || transcriptFile;
      if (transcriptFile) ts = transcript.readState(transcriptFile);
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
      hasUserSubmit: input.hasSubmitted,
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

module.exports = { run, makeInjector };
