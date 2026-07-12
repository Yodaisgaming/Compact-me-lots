'use strict';

// Classify a raw stdin chunk coming from the user. We only need to know three
// things about it: did the user SUBMIT (Enter), did they change the composer
// text (type/backspace/paste), or is it a control / mouse / navigation
// sequence we should ignore. Mouse and focus events are ignored on purpose so
// moving the cursor over the terminal never counts as activity.
function classify(data) {
  if (data === '\r' || data === '\n' || data === '\r\n') return 'submit';
  if (data === '\x7f' || data === '\b') return 'backspace';
  if (data.startsWith('\x1b[200~')) return 'paste';
  if (/^\x1b\[(M|<|I|O)/.test(data)) return 'ignore';
  if (data.charCodeAt(0) === 0x1b) return 'ignore';
  if (/^[^\x00-\x1f\x7f]+$/.test(data) && !/[\uD800-\uDFFF]/.test(data)) return 'text';
  // Anything else that still carries printable content (multi-line paste, a
  // mixed control+text burst) is treated as composer input so we defer rather
  // than ever inject over something the user is holding unsent.
  if (/[^\x00-\x1f\x7f]/.test(data)) return 'paste';
  return 'ignore';
}

// Tracks the user's composer state from the classified stdin stream.
//  - lastSubmitAt bumps ONLY on Enter, so time-since-submit (not time-since-
//    keystroke) drives the idle trigger: typing a note never delays it.
//  - pendingInput is true whenever there is unsent text in the box, which makes
//    the caller defer a compaction instead of clearing the box.
//  - seq bumps on every genuine composer action, letting a delayed injected
//    Enter abort if the user typed during the window.
class InputTracker {
  constructor(now) {
    this.lastSubmitAt = now;
    this.pendingChars = 0;
    this.pendingDirty = false;
    this.seq = 0;
  }

  note(data, now) {
    const kind = classify(data);
    switch (kind) {
      case 'submit':
        this.lastSubmitAt = now;
        this.pendingChars = 0;
        this.pendingDirty = false;
        this.seq++;
        break;
      case 'backspace':
        if (this.pendingChars > 0) this.pendingChars--;
        this.seq++;
        break;
      case 'text':
        this.pendingChars += data.length;
        this.seq++;
        break;
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

module.exports = { classify, InputTracker };
