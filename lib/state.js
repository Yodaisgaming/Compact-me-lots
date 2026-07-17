'use strict';

// Idle auto-compaction state machine.
//
// A session that has sat idle long enough that its prompt cache is about to
// lapse gets ONE cheap compaction banked while the cache is still warm: inject
// a "save state" prompt, wait for that turn to finish, then inject the compact
// command. The context collapses to a small summary, so the next cold return
// re-pays input cost on a tiny prefix instead of the whole conversation.
//
// Phases: watch -> saving -> compacting -> done. A fresh user submit re-arms it
// (the caller resets on Enter). Safety rests on the turn being COMPLETE before
// each injection, so a command never lands inside an active turn. In transcript
// mode nothing fires until a real transcript with a known context size exists;
// in generic mode nothing fires until the user has submitted at least once.
// Both rules keep injections away from fresh, empty sessions and from startup
// dialogs (folder trust, permission prompts) that an injected Enter would
// otherwise confirm.

function createMachine() {
  return { phase: 'watch', savePromptAt: 0, compactAt: 0 };
}

// ctx fields:
//   contextTokens   number|null  input+cache size of the last assistant turn
//   settled         boolean      last turn is complete / agent is waiting
//   realIdleMs      number       since the agent last responded
//   userIdleMs      number       since the user last SUBMITTED (not typed)
//   ptyQuietMs      number       since the terminal last painted
//   pendingInput    boolean      unsent text sits in the composer
//   lastAssistantAt number|null  epoch ms of the last assistant turn
//   hasTranscript   boolean      transcript-derived fields are trustworthy
//   hasUserSubmit   boolean      a real Enter was seen since the wrapper started
//   now             number       epoch ms
// returns: 'none' | 'save' | 'compact' | 'done' | 'abort'
function decide(m, ctx, cfg) {
  switch (m.phase) {
    case 'watch':
      if (ctx.pendingInput) return 'none';
      if (!ctx.settled) return 'none';
      if (cfg.useTranscript) {
        if (!ctx.hasTranscript) return 'none';
        if (ctx.contextTokens == null || ctx.contextTokens < cfg.sizeGate) return 'none';
      } else if (!ctx.hasUserSubmit) {
        return 'none';
      }
      if (ctx.realIdleMs < cfg.idleMs) return 'none';
      if (ctx.realIdleMs >= cfg.graceMs) return 'none';
      if (ctx.userIdleMs < cfg.idleMs) return 'none';
      if (ctx.ptyQuietMs < cfg.settleQuietMs) return 'none';
      m.phase = 'saving';
      m.savePromptAt = ctx.now;
      return 'save';

    case 'saving':
      if (ctx.now - m.savePromptAt > cfg.maxPhaseMs) { m.phase = 'done'; return 'abort'; }
      if (ctx.now - m.savePromptAt < cfg.minTurnMs) return 'none';
      if (!ctx.settled) return 'none';
      if (cfg.useTranscript && (!ctx.hasTranscript || ctx.lastAssistantAt == null)) return 'none';
      if (ctx.hasTranscript && ctx.lastAssistantAt <= m.savePromptAt) return 'none';
      if (ctx.ptyQuietMs < cfg.settleQuietMs) return 'none';
      m.phase = 'compacting';
      m.compactAt = ctx.now;
      return 'compact';

    case 'compacting':
      if (ctx.now - m.compactAt > cfg.maxPhaseMs) { m.phase = 'done'; return 'abort'; }
      if (ctx.now - m.compactAt < cfg.minTurnMs) return 'none';
      if (ctx.ptyQuietMs < cfg.settleQuietMs) return 'none';
      m.phase = 'done';
      return 'done';

    default:
      return 'none';
  }
}

function reset(m) {
  m.phase = 'watch';
  m.savePromptAt = 0;
  m.compactAt = 0;
}

module.exports = { createMachine, decide, reset };
