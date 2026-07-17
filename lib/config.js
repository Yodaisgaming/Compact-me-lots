'use strict';

function toInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

const DEFAULTS = {
  idleMs: 240000,
  graceMs: 1800000,
  sizeGate: 100000,
  settleQuietMs: 8000,
  minTurnMs: 10000,
  maxPhaseMs: 300000,
  sweepMs: 2000,
  injectDelayMs: 200,
  compactCmd: '/compact',
  savePrompt:
    'The prompt cache is about to expire and this context will be compacted shortly. ' +
    'Before that, persist any load-bearing state to disk (notes, TODO, handoff files) so ' +
    'nothing is lost across the compaction. If this session produced a reusable workflow ' +
    'or non-obvious gotcha, record it in the matching docs or skill. If background tasks ' +
    'or subagents are still running, note what they are and how to relaunch them - task ' +
    'handles do not survive compaction. Keep it concise. Once saved, stop and wait.',
  useTranscript: true,
  verbose: false,
};

function fromEnv(env) {
  env = env || {};
  return {
    idleMs: toInt(env.CML_IDLE_MS, DEFAULTS.idleMs),
    graceMs: toInt(env.CML_GRACE_MS, DEFAULTS.graceMs),
    sizeGate: toInt(env.CML_SIZE_GATE, DEFAULTS.sizeGate),
    settleQuietMs: toInt(env.CML_SETTLE_QUIET_MS, DEFAULTS.settleQuietMs),
    minTurnMs: toInt(env.CML_MIN_TURN_MS, DEFAULTS.minTurnMs),
    maxPhaseMs: toInt(env.CML_MAX_PHASE_MS, DEFAULTS.maxPhaseMs),
    sweepMs: toInt(env.CML_SWEEP_MS, DEFAULTS.sweepMs),
    injectDelayMs: toInt(env.CML_INJECT_DELAY_MS, DEFAULTS.injectDelayMs),
    compactCmd: env.CML_COMPACT_CMD || DEFAULTS.compactCmd,
    savePrompt: env.CML_SAVE_PROMPT || DEFAULTS.savePrompt,
    useTranscript: env.CML_NO_TRANSCRIPT ? false : DEFAULTS.useTranscript,
    verbose: env.CML_VERBOSE ? true : DEFAULTS.verbose,
  };
}

// Splits argv into flags (before `--`) and the wrapped command (after `--`).
function parseArgs(argv) {
  argv = argv || [];
  const sep = argv.indexOf('--');
  const flags = sep === -1 ? argv.slice() : argv.slice(0, sep);
  const command = sep === -1 ? [] : argv.slice(sep + 1);
  const opts = {};
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const next = () => flags[++i];
    switch (f) {
      case '--idle': { const s = toInt(next(), NaN); if (Number.isFinite(s)) opts.idleMs = s * 1000; break; }
      case '--grace': { const s = toInt(next(), NaN); if (Number.isFinite(s)) opts.graceMs = s * 1000; break; }
      case '--size-gate': { const t = toInt(next(), NaN); if (Number.isFinite(t)) opts.sizeGate = t; break; }
      case '--compact-cmd': opts.compactCmd = next(); break;
      case '--save-prompt': opts.savePrompt = next(); break;
      case '--no-transcript': opts.useTranscript = false; break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: break;
    }
  }
  return { opts, command };
}

function buildConfig(argv, env) {
  const base = fromEnv(env);
  const { opts, command } = parseArgs(argv);
  const help = !!opts.help;
  delete opts.help;
  const config = Object.assign({}, base);
  for (const k of Object.keys(opts)) {
    if (opts[k] !== undefined) config[k] = opts[k];
  }
  return { config, command, help };
}

module.exports = { DEFAULTS, fromEnv, parseArgs, buildConfig };
