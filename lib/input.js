'use strict';

const PASTE_OPEN = '\x1b[200~';
const PASTE_CLOSE = '\x1b[201~';

const NAV_SEQ = /^(?:\x1b\[(?:[AB]|[56]~|Z)|\x1bO[AB]|\x1b[\x20-\x7e]?|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\t]+)$/;

// Classify a raw stdin segment coming from the user. We only need to know three
// things about it: did the user SUBMIT (Enter), did they change the composer
// text (type/backspace/paste), or is it a control / mouse / navigation
// sequence we should ignore. Mouse and focus events are ignored on purpose so
// moving the cursor over the terminal never counts as activity.
function classify(data) {
  if (data === '\r' || data === '\n' || data === '\r\n') return 'submit';
  if (/^[\x7f\x08]+$/.test(data)) return 'backspace';
  if (data.startsWith(PASTE_OPEN)) return 'paste';
  if (/^\x1b\[(M|<|I|O)/.test(data)) return 'ignore';
  if (NAV_SEQ.test(data)) return 'nav';
  if (data.charCodeAt(0) === 0x1b) return 'ignore';
  if (/^[^\x00-\x1f\x7f]+$/.test(data) && !/[\uD800-\uDFFF]/.test(data)) return 'text';
  // Anything else that still carries printable content (multi-line paste, a
  // mixed control+text burst) is treated as composer input so we defer rather
  // than ever inject over something the user is holding unsent.
  if (/[^\x00-\x1f\x7f]/.test(data)) return 'paste';
  return 'ignore';
}

function escLen(s) {
  if (s.startsWith('\x1b[M')) return s.length >= 6 ? 6 : 0;
  if (s.startsWith('\x1b[')) {
    for (let i = 2; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return i;
      if (c >= 0x40 && c <= 0x7e) return i + 1;
    }
    return 0;
  }
  if (s.startsWith('\x1b]')) {
    const bel = s.indexOf('\x07');
    const st = s.indexOf('\x1b\\');
    if (bel === -1 && st === -1) return 0;
    if (bel === -1) return st + 2;
    if (st === -1) return bel + 1;
    return Math.min(bel + 1, st + 2);
  }
  if (s.startsWith('\x1bO')) {
    for (let i = 2; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return i;
      if (c >= 0x40 && c <= 0x7e) return i + 1;
    }
    return 0;
  }
  for (let i = 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return i;
    if (c >= 0x30 && c <= 0x7e) return i + 1;
    if (c > 0x2f) return i;
  }
  return s.length === 1 ? 1 : 0;
}

function suffixLen(s, token) {
  for (let n = Math.min(s.length, token.length - 1); n > 0; n--) {
    if (s.endsWith(token.slice(0, n))) return n;
  }
  return 0;
}

function streamSegments(data, state) {
  const out = [];
  let rest = state.pending + data;
  state.pending = '';
  while (rest.length) {
    if (state.pasting) {
      const close = rest.indexOf(PASTE_CLOSE);
      if (close === -1) {
        const keep = suffixLen(rest, PASTE_CLOSE);
        const body = rest.slice(0, rest.length - keep);
        if (body) out.push({ data: body, kind: 'paste' });
        state.pending = rest.slice(rest.length - keep);
        break;
      }
      const end = close + PASTE_CLOSE.length;
      out.push({ data: rest.slice(0, end), kind: 'paste' });
      state.pasting = false;
      rest = rest.slice(end);
      continue;
    }
    if (rest.startsWith(PASTE_OPEN)) {
      out.push({ data: PASTE_OPEN, kind: 'paste' });
      state.pasting = true;
      rest = rest.slice(PASTE_OPEN.length);
      continue;
    }
    if (PASTE_OPEN.startsWith(rest)) {
      state.pending = rest;
      break;
    }
    if (rest.charCodeAt(0) === 0x1b) {
      const n = escLen(rest);
      if (n === 0) {
        state.pending = rest;
        break;
      }
      out.push({ data: rest.slice(0, n) });
      rest = rest.slice(n);
      continue;
    }
    const special = rest.search(/[\x1b\r\n]/);
    if (special === -1) {
      out.push({ data: rest });
      break;
    }
    if (special > 0) {
      out.push({ data: rest.slice(0, special) });
      rest = rest.slice(special);
      continue;
    }
    const isCrLf = rest[0] === '\r' && rest[1] === '\n';
    out.push({ data: isCrLf ? '\r\n' : rest[0] });
    rest = rest.slice(isCrLf ? 2 : 1);
  }
  return out;
}

const WIN32_KEY = /^\x1b\[([\d;]*)_$/;
const NAV_VKS = new Set([9, 27, 33, 34, 38, 40]);

function decodeWin32(seg) {
  const m = WIN32_KEY.exec(seg);
  if (!m) return null;
  const fields = m[1].split(';');
  if (fields.length > 6) return null;
  const param = (i, fallback) => fields[i] == null || fields[i] === '' ? fallback : parseInt(fields[i], 10);
  const vk = param(0, 0);
  const uc = param(2, 0);
  const kd = param(3, 0);
  const cs = param(4, 0);
  const rc = param(5, 1);
  if (kd !== 1) return { kind: 'ignore', chars: 0 };
  if (uc === 13 || uc === 10 || vk === 13) {
    return cs & 0x1f ? { kind: 'text', chars: rc } : { kind: 'submit', chars: 0 };
  }
  if (uc === 8 || uc === 127 || vk === 8) return { kind: 'backspace', chars: rc };
  if (uc >= 32) return { kind: 'text', chars: rc, char: String.fromCharCode(uc) };
  if (uc > 0) return { kind: 'nav', chars: 0 };
  if (NAV_VKS.has(vk)) return { kind: 'nav', chars: 0 };
  return { kind: 'ignore', chars: 0 };
}

// Tracks the user's composer state from the classified stdin stream.
//  - lastSubmitAt bumps ONLY on Enter, so time-since-submit (not time-since-
//    keystroke) drives the idle trigger: typing a note never delays it.
//  - pendingInput is true whenever there is unsent text in the box, which makes
//    the caller defer a compaction instead of clearing the box.
//  - seq bumps on every genuine composer action, letting a delayed injected
//    Enter abort if the user typed during the window.
//  - a chunk can merge text with the Enter that submits it (tmux, ssh and
//    ConPTY batch keystrokes; pastes can end in a newline), so chunks are
//    split into segments before classification and an embedded Enter counts
//    as a real submit instead of wedging pendingInput.
class InputTracker {
  constructor(now) {
    this.lastSubmitAt = now;
    this.pendingChars = 0;
    this.pendingDirty = false;
    this.hasSubmitted = false;
    this.seq = 0;
    this.segmentState = { pending: '', pasting: false };
  }

  note(data, now) {
    let result = 'ignore';
    const parts = streamSegments(data, this.segmentState);
    if (data && this.segmentState.pending) this.seq++;
    for (const item of parts) {
      const seg = item.data;
      const w = decodeWin32(seg);
      const kind = item.kind || (w ? w.kind : classify(seg));
      switch (kind) {
        case 'submit':
          this.lastSubmitAt = now;
          this.hasSubmitted = true;
          this.pendingChars = 0;
          this.pendingDirty = false;
          this.seq++;
          break;
        case 'backspace':
          this.pendingChars = Math.max(0, this.pendingChars - (w ? w.chars : seg.length));
          this.seq++;
          break;
        case 'text': {
          const ch = w ? w.char : seg;
          if (ch === ' ' && this.pendingChars === 0 && !this.pendingDirty) {
            this.pendingDirty = true;
          } else {
            this.pendingChars += w ? w.chars : seg.length;
          }
          this.seq++;
          break;
        }
        case 'nav':
        case 'paste':
          this.pendingDirty = true;
          this.seq++;
          break;
        default:
          break;
      }
      if (kind === 'submit' || (result !== 'submit' && kind !== 'ignore')) result = kind;
    }
    return result;
  }

  get pendingInput() {
    return this.pendingChars > 0 || this.pendingDirty ||
      !!(this.segmentState.pending && PASTE_OPEN.startsWith(this.segmentState.pending));
  }
}

module.exports = { classify, InputTracker };
