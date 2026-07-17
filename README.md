# compact-me-lots

Keep an idle agent CLI cheap to resume.

`compact-me-lots` wraps a command like `claude` in a pseudo-terminal and watches it in the background. When the session goes idle while its prompt cache is still warm, it banks a cheap compaction for you: it asks the agent to save its state, waits for that turn to finish, then runs the compact command. When you come back, the cold re-entry pays input cost on a small summary instead of the entire conversation.

You use your terminal exactly as before. The wrapper is transparent.

## Why

Agent CLIs keep a rolling prompt cache (the exact window varies by provider and tier, often a few minutes). While it is warm, re-sending the context is cheap. Once it lapses, the next message re-pays full input cost on the whole conversation. If you step away with a large context open, the cache goes cold and your return is expensive.

Most context tools compact when the window fills up. `compact-me-lots` is different: it fires on **idle plus cache warmth**. If you have walked away and the cache is about to lapse, it compacts now, while it is still cheap, so the return is cheap too.

## Install

```sh
npm install -g compact-me-lots
# or run without installing:
npx compact-me-lots -- claude
```

Requires Node.js 18 or newer. Works on Linux, macOS, and Windows (PowerShell, Windows Terminal, or cmd).

## Usage

Put the command you normally run after `--`:

```sh
compact-me-lots -- claude
compact-me-lots --idle 240 --verbose -- claude
compact-me-lots --no-transcript --compact-cmd "/compact" -- some-agent-cli
```

Everything after `--` is launched as-is, so any flags for the wrapped command pass straight through.

### Transparent alias

If you would rather keep typing plain `claude`, add a shell function.

PowerShell (`$PROFILE`):

```powershell
function claude { npx compact-me-lots -- claude.cmd @args }
```

bash / zsh (`~/.bashrc` or `~/.zshrc`):

```sh
claude() { npx compact-me-lots -- command claude "$@"; }
```

## How it works

```
you --type--> compact-me-lots (pty wrapper) --> claude
                     |
                     | tracks: time since you SUBMITTED, terminal quiet time,
                     |         and (for Claude) real context size from the transcript
                     |
                     | when idle + cache about to lapse and the turn is complete:
                     +--> inject a save-state prompt
                          --> wait for that turn to finish
                              --> inject the compact command
```

Key behaviors:

- **The idle timer resets on submit, not on keystrokes.** Typing a long note never delays a compaction, because typing does not mean you are about to send before the cache lapses. Only pressing Enter counts as activity.
- **Unsent input is never clobbered.** If text is sitting in the composer, the wrapper waits instead of injecting over it.
- **Untrackable input also defers.** The wrapper only sees keystrokes, not the composer itself. Keys that can pull content into the box without it crossing stdin — Up/Down and PgUp/PgDn (history recall, which in Claude Code replaces even a non-empty draft), Ctrl-chords (reverse-search, kill/yank), Tab and Shift+Tab (completion, overlays), bare or Alt-modified Esc, and a bare leading space (voice push-to-talk inserts transcripts internally) — all mark the composer as possibly non-empty until your next real submit. Terminal auto-responses (cursor-position reports, device attributes, OSC replies) are recognized and ignored, so they can never wedge or reset the tracker.
- **Nothing is ever injected before your first submit.** A freshly launched session can still be showing a trust or permission dialog, and an injected Enter would accept it. The wrapper stays completely inactive until you have sent at least one real message.
- **It avoids interrupting an active turn.** Injection only happens once the current turn looks complete. In Claude mode this is read precisely from the session transcript (the last turn's stop reason, so a mid-turn tool call is never mistaken for idle). In generic mode it is inferred from a long idle plus terminal quiet, which is a heuristic, so Claude mode is preferred (see Limitations).
- **Small or abandoned sessions are left alone.** Below a size gate a cold return is already cheap, and a session idle for longer than the grace window is treated as abandoned.

### Claude mode vs generic mode

By default the wrapper reads Claude Code's session transcript (`~/.claude/projects/...`) to know the real context size and when a turn has truly completed. The transcript is located by matching the project-dir slug AND verifying that the transcript's own head records name the wrapper's working directory, so with several sessions open it can never latch onto another session's transcript. In Claude mode the wrapper stays inactive until a matching transcript exists — it never silently falls back to guessing. Pass `--no-transcript` to wrap non-Claude CLIs with terminal-quiet heuristics and a configurable compact command.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--idle <seconds>` | `240` | Idle time before a compaction is banked |
| `--grace <seconds>` | `1800` | Past this the session is treated as abandoned and left alone |
| `--size-gate <tokens>` | `100000` | Minimum context size worth compacting (Claude transcript mode only) |
| `--compact-cmd <text>` | `/compact` | Command injected to compact |
| `--save-prompt <text>` | built-in | Prompt injected before compacting to persist state |
| `--no-transcript` | off | Ignore the Claude transcript; use terminal quiet time only |
| `--verbose`, `-v` | off | Log decisions to stderr |
| `--help`, `-h` | | Show help |

Every option also has a `CML_*` environment variable (`CML_IDLE_MS`, `CML_GRACE_MS`, `CML_SIZE_GATE`, `CML_COMPACT_CMD`, `CML_SAVE_PROMPT`, `CML_NO_TRANSCRIPT`, `CML_VERBOSE`).

## Limitations

- **Generic mode is a heuristic.** Without the Claude transcript it decides "the turn is done" from a long idle plus terminal quiet. An agent that stalls silently mid-turn for the full idle window could in principle be interrupted. Claude mode does not have this problem because it reads the real turn state. Use `--no-transcript` only for non-Claude CLIs.
- **Injection interleave.** If you start typing in the brief window (~200ms) after an injection begins, the tool cancels its own Enter, so nothing is submitted on your behalf. The already-written prompt text may momentarily interleave with your keystrokes in the composer. If you see that, clear the line and retype. Nothing is sent without a real, uninterrupted Enter.
- **Deferral is conservative on purpose.** Anything the wrapper cannot prove about the composer (a paste it could not parse, a history key, a possible voice transcript) parks the compaction until your next submit. A skipped compaction costs a little money; a wrong injection could submit garbage into your session. There is no safe way to blindly clear an agent CLI's composer from outside (in Claude Code, single Esc does not clear, and double-Esc on an empty composer opens the rewind picker), so the wrapper never tries.

## Changelog

### 0.2.0

- **Fixed: injected Enter could accept a trust/permission dialog on a fresh session.** The wrapper now stays completely inactive until the user has submitted at least once, and Claude mode no longer falls back to terminal heuristics when no transcript is found.
- **Fixed: a merged `text\r` stdin chunk permanently wedged the input tracker.** Chunks ending in Enter now count as a submit (this happens routinely under session managers, tmux, and ssh buffering).
- **Fixed: the wrapper could latch another session's transcript.** Transcript candidates are now verified against the cwd recorded in their own head records, an all-non-alphanumerics slug candidate covers paths with underscores, and cross-directory fallback only accepts files created after the wrapper started.
- **Fixed: the input tracker was blind on Windows Terminal.** ConPTY's win32-input-mode key records (`ESC[Vk;Sc;Uc;Kd;Cs;Rc_`) are now decoded back into chars and keys before classification.
- **New: history/overlay-capable keys defer compaction.** Up/Down/PgUp/PgDn/Ctrl-chords/Tab/Shift+Tab/Esc can pull untrackable content into the composer (history recall replaces even a non-empty draft in Claude Code); they now mark it possibly-non-empty until the next submit. A bare leading space (voice push-to-talk) does the same. Terminal auto-responses are explicitly recognized and ignored.
- **Changed: the default save prompt** now also asks the agent to record reusable workflows in docs/skills and to note running background tasks with relaunch instructions, since task handles do not survive compaction.

## License

MIT
