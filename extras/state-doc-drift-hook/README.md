# State-doc drift hook (Claude Code extra)

A companion to `compact-me-lots` for Claude Code users. The wrapper's save prompt persists state *at* compaction time; this hook keeps your project's state docs fresh *between* compactions, so any compaction (yours, the wrapper's, or Claude Code's own auto-compact) loses less.

It is a [Claude Code Stop hook](https://code.claude.com/docs/en/hooks): at the end of a turn it checks how much conversation has accumulated since your state docs were last touched, and when that drift is large it asks the agent once to bring the docs up to date before ending the turn.

It stays silent unless ALL of these hold:

- the project working directory contains at least one of your state docs
- the transcript grew more than 1.5 MB since any state doc was last modified
- the turn that just ended did real work (>20 KB of transcript) — a short answer to a quick question never triggers it
- no reminder fired in the last 20 minutes

The reminder explicitly permits "nothing to record, just stop", so it cannot loop: after one firing the drift watermark resets and a cooldown starts.

## Install

Copy `check-state-doc-drift.js` somewhere stable (e.g. `~/.claude/hooks/`), then register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/check-state-doc-drift.js", "timeout": 10 }] }
    ]
  }
}
```

On Windows, write the absolute path instead of `~` (e.g. `node C:/Users/you/.claude/hooks/check-state-doc-drift.js`) - the hook command runs through a shell that does not expand `~` there.

Running sessions snapshot their hook config at startup; the hook takes effect in new sessions. It does not invalidate any session's prompt cache (hooks are not part of the model prompt; a firing only appends to the conversation).

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `CML_DRIFT_DOCS` | `TODO.md,NOTES.md,HANDOFF.md` | Comma-separated doc filenames looked up in the project cwd. The hook is inert in projects containing none of them. |
| `CML_DRIFT_BYTES` | `1500000` | Transcript growth since the last doc touch before a reminder is considered |
| `CML_DRIFT_MIN_TURN_BYTES` | `20000` | Minimum size of the just-ended turn — smaller turns never fire |
| `CML_DRIFT_COOLDOWN_MS` | `1200000` | Minimum time between reminders per session |

## Safety properties

- Fail-open: any error (unreadable transcript, bad state file, failed write) results in silence, never a block. A reminder is only emitted after its bookkeeping was successfully persisted, so a broken state dir cannot cause repeat nagging.
- Per-session watermark state lives in `~/.claude/hooks/.state-doc-drift/<session_id>.json` (atomic writes, 7-day auto-prune). Session ids are validated before being used in paths.
- A transcript that shrinks or is replaced (compaction, resume) rebases the watermark instead of misfiring.
