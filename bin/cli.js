#!/usr/bin/env node
'use strict';

const { buildConfig } = require('../lib/config');

const HELP = `compact-me-lots - keep an idle agent CLI cheap to resume.

Wraps a command in a pseudo-terminal and, when the session goes idle while its
prompt cache is still warm, banks a cheap compaction: it saves state, waits for
that turn to finish, then compacts. When you come back the cold re-entry pays
input cost on a small summary instead of the whole conversation.

Usage:
  compact-me-lots [options] -- <command> [args...]

Examples:
  compact-me-lots -- claude
  compact-me-lots --idle 240 --verbose -- claude
  compact-me-lots --no-transcript --compact-cmd "/compact" -- some-agent-cli

Options:
  --idle <seconds>       Idle time before a compaction is banked (default 240)
  --grace <seconds>      Past this, the session is treated as abandoned and left
                         alone (default 1800)
  --size-gate <tokens>   Minimum context size worth compacting; only applies in
                         Claude transcript mode (default 100000)
  --compact-cmd <text>   Command injected to compact (default "/compact")
  --save-prompt <text>   Prompt injected before compacting to persist state
  --no-transcript        Do not read the Claude transcript; rely on terminal
                         quiet time only (use for non-Claude CLIs)
  --verbose, -v          Log decisions to stderr
  --version, -V          Print the version and exit
  --help, -h             Show this help

All options can also be set via CML_* environment variables (CML_IDLE_MS,
CML_GRACE_MS, CML_SIZE_GATE, CML_COMPACT_CMD, CML_SAVE_PROMPT, CML_NO_TRANSCRIPT,
CML_VERBOSE).
`;

function main() {
  const { config, command, help, version } = buildConfig(process.argv.slice(2), process.env);
  if (version) {
    process.stdout.write(require('../package.json').version + '\n');
    process.exit(0);
  }
  if (help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (!command.length) {
    process.stderr.write('compact-me-lots: no command given.\n\n' + HELP);
    process.exit(2);
  }
  const { run } = require('../lib/wrapper');
  run(command, config);
}

main();
