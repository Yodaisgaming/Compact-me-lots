'use strict';

function toInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

// Like toInt, but returns null when v is absent OR unparseable. Lets callers
// tell "set to a real number" apart from "not set / a typo", so an invalid
// CML_IDLE_MS is never mistaken for an explicit pin.
function optInt(v) {
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function truthy(v) {
  return v === '1' || v === 'true';
}

// Parse a TTL spec into milliseconds: "5m", "1h", or a bare number of SECONDS.
// Strict on purpose: a typo like "5min", "600s", or "1.5" must NOT silently
// become a few seconds and trigger near-instant compaction. Returns null if it
// can't be parsed to one of those exact forms.
function parseTtl(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (s === '5m') return 300000;
  if (s === '1h') return 3600000;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n * 1000 : null;
}

const TTL_5M = 300000;
const TTL_1H = 3600000;
const DEFAULT_TTL_MS = TTL_1H; // Claude Code's default cache TTL on a subscription.

// The idle timer and the abandoned-grace window are both derived from the cache
// TTL, so the whole tool re-tunes itself when the TTL changes:
//   idle  = 80% of the TTL  -> bank the compaction while the cache is still warm,
//                              leaving a 20% margin before it lapses.
//   grace = 6x the TTL      -> past this the session is treated as abandoned.
// Both formulas reproduce the previous fixed 5-minute-TTL numbers exactly:
//   idle  = 300000 * 0.8 = 240000  (4 min, the old default)
//   grace = 300000 * 6   = 1800000 (30 min, the old default)
function idleFromTtl(ttlMs) { return Math.round(ttlMs * 0.8); }
function graceFromTtl(ttlMs) { return Math.round(ttlMs * 6); }

const DEFAULTS = {
  ttlMs: DEFAULT_TTL_MS,
  idleMs: idleFromTtl(DEFAULT_TTL_MS),   // 2,880,000 (48 min)
  graceMs: graceFromTtl(DEFAULT_TTL_MS), // 21,600,000 (6 h)
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

// Resolve the cache TTL (and where the decision came from, for --verbose) using
// the same signals Claude Code itself uses to pick 5m vs 1h. Priority order:
//   1. CML_TTL                            - explicit override for this tool
//   2. FORCE_PROMPT_CACHING_5M=1           - Claude Code force-5m (wins over 1h opt-in)
//   3. ENABLE_PROMPT_CACHING_1H=1          - Claude Code 1h opt-in
//   4. API-key / third-party auth present  - those default to 5m in Claude Code
//   5. default                             - 1h (Claude Code's subscription default)
// A CLI `--ttl` flag (handled in buildConfig) overrides all of these. Detection
// is best-effort: it cannot see a mid-session drop from 1h to 5m when a
// subscription goes over its plan limit, so `default-1h` is an assumption, not a
// guarantee. Pass `--ttl 5m` if you know your cache is short.
function resolveTtl(env) {
  const explicit = parseTtl(env.CML_TTL);
  if (explicit != null) return { ttlMs: explicit, ttlSource: 'CML_TTL' };
  if (truthy(env.FORCE_PROMPT_CACHING_5M)) return { ttlMs: TTL_5M, ttlSource: 'FORCE_PROMPT_CACHING_5M' };
  if (truthy(env.ENABLE_PROMPT_CACHING_1H)) return { ttlMs: TTL_1H, ttlSource: 'ENABLE_PROMPT_CACHING_1H' };
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ||
      truthy(env.CLAUDE_CODE_USE_BEDROCK) || truthy(env.CLAUDE_CODE_USE_VERTEX) ||
      truthy(env.CLAUDE_CODE_USE_FOUNDRY)) {
    return { ttlMs: TTL_5M, ttlSource: 'api-key-auth' };
  }
  return { ttlMs: DEFAULT_TTL_MS, ttlSource: 'default-1h' };
}

// True if any DISABLE_PROMPT_CACHING[_MODEL] flag is on. With caching off there is
// no warm window to bank against, so the wrapper can warn (see wrapper.js).
function cachingDisabled(env) {
  return Object.keys(env).some(
    (k) => /^DISABLE_PROMPT_CACHING(_[A-Z0-9]+)?$/.test(k) && truthy(env[k])
  );
}

function fromEnv(env) {
  env = env || {};
  const { ttlMs, ttlSource } = resolveTtl(env);
  // idle/grace honor an explicit, PARSEABLE CML_* override, else derive from the
  // resolved TTL. A malformed override falls through to the derived value.
  const idleOverride = optInt(env.CML_IDLE_MS);
  const graceOverride = optInt(env.CML_GRACE_MS);
  return {
    ttlMs,
    ttlSource,
    idleMs: idleOverride != null ? idleOverride : idleFromTtl(ttlMs),
    graceMs: graceOverride != null ? graceOverride : graceFromTtl(ttlMs),
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
    cachingDisabled: cachingDisabled(env),
  };
}

function warnFlag(name, raw, expected) {
  const shown = raw === undefined ? '(missing value)' : JSON.stringify(raw);
  process.stderr.write('compact-me-lots: ignoring ' + name + ' ' + shown + ' - ' + (expected || 'expected a number') + '\n');
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
      case '--ttl': { const raw = next(); const ms = parseTtl(raw); if (ms != null) opts.ttlMs = ms; else warnFlag('--ttl', raw, 'expected 5m, 1h, or a positive number of seconds'); break; }
      case '--idle': { const raw = next(); const s = toInt(raw, NaN); if (Number.isFinite(s)) opts.idleMs = s * 1000; else warnFlag('--idle', raw); break; }
      case '--grace': { const raw = next(); const s = toInt(raw, NaN); if (Number.isFinite(s)) opts.graceMs = s * 1000; else warnFlag('--grace', raw); break; }
      case '--size-gate': { const raw = next(); const t = toInt(raw, NaN); if (Number.isFinite(t)) opts.sizeGate = t; else warnFlag('--size-gate', raw); break; }
      case '--compact-cmd': opts.compactCmd = next(); break;
      case '--save-prompt': opts.savePrompt = next(); break;
      case '--no-transcript': opts.useTranscript = false; break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '--version': case '-V': opts.version = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: break;
    }
  }
  return { opts, command };
}

function buildConfig(argv, env) {
  env = env || {};
  const base = fromEnv(env);
  const { opts, command } = parseArgs(argv);
  const help = !!opts.help;
  const version = !!opts.version;
  delete opts.help;
  delete opts.version;

  const config = Object.assign({}, base);

  // A CLI --ttl overrides every env signal and re-derives idle/grace, UNLESS the
  // user also pinned idle/grace explicitly (flag or a PARSEABLE CML_* env), which win.
  if (opts.ttlMs !== undefined) {
    config.ttlMs = opts.ttlMs;
    config.ttlSource = '--ttl';
    const idlePinned = opts.idleMs !== undefined || optInt(env.CML_IDLE_MS) != null;
    const gracePinned = opts.graceMs !== undefined || optInt(env.CML_GRACE_MS) != null;
    if (!idlePinned) config.idleMs = idleFromTtl(opts.ttlMs);
    if (!gracePinned) config.graceMs = graceFromTtl(opts.ttlMs);
  }

  for (const k of Object.keys(opts)) {
    if (opts[k] !== undefined) config[k] = opts[k];
  }
  return { config, command, help, version };
}

module.exports = {
  DEFAULTS, fromEnv, parseArgs, buildConfig,
  parseTtl, resolveTtl, idleFromTtl, graceFromTtl,
};
