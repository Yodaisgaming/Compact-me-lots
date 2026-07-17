'use strict';

const NAV_KEY_SEQ = /^(?:\x1b\[(?:[ABCDHF]|[1-6]~|Z)|\x1bO[ABCDHF]|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\t]|\x1b[\x20-\x7e]?)+$/;

const WIN32_INPUT_RE = /\x1b\[(\d+);(\d+);(\d+);(\d+);(\d+);(\d+)_/g;
const VK_TO_SEQ = {
  33: '\x1b[5~', 34: '\x1b[6~', 35: '\x1b[F', 36: '\x1b[H',
  37: '\x1b[D', 38: '\x1b[A', 39: '\x1b[C', 40: '\x1b[B',
  45: '\x1b[2~', 46: '\x1b[3~',
};

function decodeWin32Input(data) {
  if (!data.includes('\x1b[') || !data.includes('_')) return data;
  WIN32_INPUT_RE.lastIndex = 0;
  if (!WIN32_INPUT_RE.test(data)) return data;
  return data.replace(WIN32_INPUT_RE, (m, vk, sc, uc, kd, cs, rc) => {
    if (kd === '0') return '';
    const u = parseInt(uc, 10);
    const n = Math.max(1, parseInt(rc, 10) || 1);
    if (u > 0) return String.fromCharCode(u).repeat(n);
    const seq = VK_TO_SEQ[parseInt(vk, 10)];
    return seq ? seq.repeat(n) : '';
  });
}

function classify(data) {
  data = decodeWin32Input(data);
  if (data.startsWith('\x1b[200~')) return 'paste';
  if (/^\x1b\[(M|<|I|O)/.test(data)) return 'ignore';
  if (/^\x1b\][^]*(\x07|\x1b\\)$/.test(data)) return 'ignore';
  if (data === '\x7f' || data === '\b') return 'backspace';
  if (/[\r\n]$/.test(data)) return 'submit';
  if (NAV_KEY_SEQ.test(data)) return 'nav';
  if (data.charCodeAt(0) === 0x1b) return 'ignore';
  if (/^[^\x00-\x1f\x7f]+$/.test(data) && !/[\uD800-\uDFFF]/.test(data)) return 'text';
  if (/[^\x00-\x1f\x7f]/.test(data)) return 'paste';
  return 'ignore';
}

class InputTracker {
  constructor(now) {
    this.lastSubmitAt = now;
    this.submitCount = 0;
    this.pendingChars = 0;
    this.pendingDirty = false;
    this.seq = 0;
  }

  note(data, now) {
    data = decodeWin32Input(data);
    const kind = classify(data);
    switch (kind) {
      case 'submit':
        this.lastSubmitAt = now;
        this.submitCount++;
        this.pendingChars = 0;
        this.pendingDirty = false;
        this.seq++;
        break;
      case 'backspace':
        if (this.pendingChars > 0) this.pendingChars--;
        this.seq++;
        break;
      case 'text':
        if (data === ' ' && this.pendingChars === 0 && !this.pendingDirty) {
          this.pendingDirty = true;
        } else {
          this.pendingChars += data.length;
        }
        this.seq++;
        break;
      case 'nav':
      case 'paste':
        this.pendingDirty = true;
        this.seq++;
        break;
      default:
        break;
    }
    return kind;
  }

  get pendingInput() {
    return this.pendingChars > 0 || this.pendingDirty;
  }
}

module.exports = { classify, InputTracker, NAV_KEY_SEQ, decodeWin32Input };
