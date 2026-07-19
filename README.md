# compact-me-lots

Keep an idle agent CLI cheap to resume.

![compact-me-lots banking a compaction on an idle Claude Code session](https://raw.githubusercontent.com/Yodaisgaming/Compact-me-lots/main/docs/demo.svg)

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
- **Untrackable input also defers.** The wrapper only sees keystrokes, not the composer itself. Keys that can pull content into the box without it crossing stdin — Up/Down and PgUp/PgDn (history recall, which in Claude Code replaces even a non-empty draft), Ctrl-chords (reverse-search, kill/yank), Tab and Shift+Tab (completion, overlays), bare or Alt-modified Esc, and a bare leading space (voice push-to-talk inserts transcripts internally) — all mark the composer as possibly non-empty until your next real submit. Cursor-only keys (Left/Right/Home/End) cannot introduce content and stay ignored, as do terminal auto-responses (cursor-position reports, device attributes, OSC replies), so none of those can wedge or needlessly defer the tracker.
- **It avoids interrupting an active turn.** Injection only happens once the current turn looks complete. In Claude mode this is read precisely from the session transcript (the last turn's stop reason, so a mid-turn tool call is never mistaken for idle). In generic mode it is inferred from a long idle plus terminal quiet, which is a heuristic, so Claude mode is preferred (see Limitations).
- **Small or abandoned sessions are left alone.** Below a size gate a cold return is already cheap, and a session idle for longer than the grace window is treated as abandoned.
- **Fresh, unused sessions are never touched.** In Claude mode nothing fires until the session transcript exists with a known context size, and in generic mode nothing fires until you have submitted at least once. This keeps injections away from empty sessions and away from startup dialogs (folder trust, permission prompts) that an injected Enter would otherwise confirm.
- **Batched keystrokes are handled.** Terminals and multiplexers (tmux, ssh, ConPTY) can deliver text and its Enter in one chunk, and pastes can end with a newline. Chunks are split on Enter boundaries, so a merged submit is recognized instead of being mistaken for an unsent draft.

### Claude mode vs generic mode

By default the wrapper reads Claude Code's session transcript (`~/.claude/projects/...`) to know the real context size and when a turn has truly completed. A candidate transcript is only accepted when its records name the wrapper's own working directory, so with several Claude sessions open the wrapper never latches onto a different session's transcript. Discovery re-runs continuously, which also follows Claude Code when it continues in a new session file after a compaction. Pass `--no-transcript` when wrapping a non-Claude CLI to fall back to terminal-quiet heuristics with a configurable compact command.

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
| `--version`, `-V` | | Print the version |
| `--help`, `-h` | | Show help |

Every option also has a `CML_*` environment variable (`CML_IDLE_MS`, `CML_GRACE_MS`, `CML_SIZE_GATE`, `CML_COMPACT_CMD`, `CML_SAVE_PROMPT`, `CML_NO_TRANSCRIPT`, `CML_VERBOSE`).

Tune `--size-gate` to the context size where a cold resume actually starts to hurt for you. A good anchor is your own typical post-compact context: if a fresh session settles around, say, 180k tokens, set the gate near there so only sessions large enough to be worth it get banked. The `100000` default is a conservative floor.

## Limitations

- **Generic mode is a heuristic.** Without the Claude transcript it decides "the turn is done" from a long idle plus terminal quiet. An agent that stalls silently mid-turn for the full idle window could in principle be interrupted. It also cannot tell a composer apart from a dialog, so a prompt that appears while you are away could receive the injected Enter. Claude mode has neither problem because it reads the real turn state and stays inert until a transcript exists. Use `--no-transcript` only for non-Claude CLIs, and prefer agents whose idle screens are genuinely quiet.
- **Injection interleave.** If you start typing in the brief window (~200ms) after an injection begins, the tool cancels its own Enter, so nothing is submitted on your behalf. The already-written prompt text may momentarily interleave with your keystrokes in the composer. If you see that, clear the line and retype. Nothing is sent without a real, uninterrupted Enter.
- **Deferral is conservative on purpose.** Anything the wrapper cannot prove about the composer (a paste, a history key, a possible voice transcript) parks the compaction until your next submit. A skipped compaction costs a little money; a wrong injection could submit garbage into your session. There is no safe way to blindly clear an agent CLI's composer from outside (in Claude Code, single Esc does not clear, and double-Esc on an empty composer opens the rewind picker), so the wrapper never tries.

## Changelog

### 0.2.2

- **Fixed: the injected Enter is now delivered reliably.** Under heavy PTY output the delayed Enter could be paste-fused with the prompt body and silently swallowed, leaving the prompt unsent in the composer. The Enter now waits for a short output-quiet gap, and in transcript mode delivery is verified against the session transcript: only an appended non-sidechain user record whose content exactly matches the injected text (or its slash-command record) counts. A swallowed Enter is retried up to 3 times; any foreign transcript activity, session-file rotation, or user input aborts the cycle instead.
- Phase timers now measure from the actual submit, not the body write.
- Generic mode gets the quiet-gap wait but no blind retries (there is no transcript to verify against).

### 0.2.1

- **Fixed: a batched backspace run (held key over ssh/tmux/ConPTY arrives as one chunk) now clears the draft counter.** Previously `\x7f\x7f...` was ignored and `\b\b...` was misread as navigation, so an actually-empty composer could keep deferring compaction until the next submit.
- **Fixed: an ignore-only chunk that ends in a partial escape sequence now aborts a pending injected Enter**, closing a narrow gap in the type-during-injection cancel window.
- **Fixed: the "unsent pending input defers compaction" integration test now actually exercises that gate** (it previously passed via the no-submit gate alone).
- Removed the unused `segments()` export (superseded by the streaming segmenter in 0.1.1).

### 0.2.0

- **Fixed: history and overlay keys could let injection fire over untrackable composer content.** Up/Down, PgUp/PgDn, Ctrl-chords, Tab/Shift+Tab, and Esc can pull content into the composer without it crossing stdin (in Claude Code, history recall replaces even a non-empty draft). They now mark the composer possibly-non-empty until the next real submit — in both ANSI and win32-input-mode key encodings.
- **New: a bare leading space defers too.** Claude Code binds Space on an empty composer to voice push-to-talk, which inserts the transcript internally where the wrapper cannot see it.
- **Changed: the default save prompt** now also asks the agent to record reusable workflows in docs/skills and to note running background tasks with relaunch instructions, since task handles do not survive compaction.

### 0.1.1

- Never fire on unused sessions: Claude mode requires a real transcript with a known context size, generic mode requires a first submit (keeps injected Enter away from trust/permission dialogs).
- Parse stdin into segments: merged text+Enter chunks, escape sequences and paste markers split across chunks, and ConPTY win32-input-mode key records are all recognized correctly.
- Verify and re-discover the session transcript: candidates must name the wrapper's own working directory, so the wrapper never latches onto another session's transcript, and discovery follows Claude Code into post-compaction session files.

## License

MIT
