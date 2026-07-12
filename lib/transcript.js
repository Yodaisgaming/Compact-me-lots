'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Claude Code writes a per-session JSONL transcript under
// ~/.claude/projects/<slug>/<uuid>.jsonl, where <slug> is the working directory
// with its path separators (and drive colon / dots) flattened to single dashes,
// e.g. C:\Users\me\proj -> C--Users-me-proj. Reading it lets us gate on real
// context size and know when a turn has actually completed, rather than guessing
// from terminal output alone. Every function here is best-effort: on any mismatch
// it returns null and the caller falls back to terminal-quiet heuristics.
//
// A turn is COMPLETE when the last message-bearing record is an assistant message
// whose stop_reason is a natural stop (end_turn / stop_sequence). An assistant
// record with stop_reason "tool_use" means Claude is mid-turn waiting on a tool,
// and a trailing "user" record means Claude still owes a reply — neither is
// settled, so we never inject then.

const TERMINAL_STOP = new Set(['end_turn', 'stop_sequence']);

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Two slug spellings: dots-as-dashes (Claude Code's actual rule) and dots-kept,
// so a path with dots still has a chance to match. The common no-dot path is
// identical under both.
function slugCandidates(cwd) {
  const a = cwd.replace(/[:\\/.]/g, '-');
  const b = cwd.replace(/[:\\/]/g, '-');
  return a === b ? [a] : [a, b];
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Newest *.jsonl touched at/after the wrap started. Prefers the project dir(s)
// matching cwd; if none exist, scans every project dir so a slightly-off slug
// still locates the freshly-launched session.
function findTranscript(cwd, since) {
  const root = projectsRoot();
  const seen = new Set();
  let dirs = [];
  for (const slug of slugCandidates(cwd)) {
    const d = path.join(root, slug);
    if (!seen.has(d) && isDir(d)) { seen.add(d); dirs.push(d); }
  }
  if (!dirs.length) {
    try {
      dirs = fs.readdirSync(root).map((n) => path.join(root, n)).filter(isDir);
    } catch {
      return null;
    }
  }
  let best = null;
  let bestMtime = 0;
  for (const d of dirs) {
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(d, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs >= bestMtime && st.mtimeMs >= since - 5000) {
        bestMtime = st.mtimeMs;
        best = full;
      }
    }
  }
  return best;
}

function tailLines(file, maxBytes) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// Derives, from the transcript tail:
//   contextTokens   input+cache size of the last assistant turn (approx size gate)
//   settled         last message record is an assistant turn that ended naturally
//   lastAssistantAt epoch ms of the last assistant record
// Non-message record types (mode, file-history-snapshot, last-prompt, ai-title,
// permission-mode, ...) are skipped. Returns null if nothing usable was found.
function readState(file) {
  const lines = tailLines(file, 512 * 1024);
  if (!lines.length) return null;
  let contextTokens = null;
  let lastAssistantAt = null;
  let lastMsgType = null;
  let lastAssistantStop = null;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const type = obj.type;
    if (type !== 'assistant' && type !== 'user') continue;
    lastMsgType = type;
    if (type === 'assistant') {
      const msg = obj.message || {};
      lastAssistantStop = msg.stop_reason || null;
      const u = msg.usage;
      if (u) {
        const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (t > 0) contextTokens = t;
      }
      if (obj.timestamp) {
        const ts = Date.parse(obj.timestamp);
        if (!Number.isNaN(ts)) lastAssistantAt = ts;
      }
    }
  }
  if (lastMsgType == null) return null;
  const settled = lastMsgType === 'assistant' && TERMINAL_STOP.has(lastAssistantStop);
  return { contextTokens, settled, lastAssistantAt };
}

module.exports = { projectsRoot, slugCandidates, findTranscript, tailLines, readState };
