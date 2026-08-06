# overseer-nvim-mcp

An [MCP](https://modelcontextprotocol.io) server that gives a coding agent the
same control over [overseer.nvim](https://github.com/stevearc/overseer.nvim)
tasks that you have: list, tail, run, restart, stop, and dispose.

![An agent starts a dev server as an overseer task; the user watches its output in the task list and stops it themselves](https://raw.githubusercontent.com/impossiblecode/overseer-nvim-mcp/main/.github/demo.gif)

[![npm](https://img.shields.io/npm/v/overseer-nvim-mcp)](https://www.npmjs.com/package/overseer-nvim-mcp)
[![CI](https://github.com/impossiblecode/overseer-nvim-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/impossiblecode/overseer-nvim-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why

Your agent's shell tool and your overseer task list are separate execution
worlds. A dev server the agent starts in its own shell is invisible in the task
list, can't be stopped from it, and orphans its process tree when the session
ends. Tasks *you* start get proper teardown. This closes that gap: the agent's
long-running commands become real overseer tasks.

## Requirements

- Neovim with [overseer.nvim](https://github.com/stevearc/overseer.nvim)
  (tested against `v2.1.0`)
- Node >= 22
- An MCP client running **inside** a Neovim terminal buffer

## Install

The server speaks stdio and is started by your MCP client. The command is
always the same:

```
npx -y overseer-nvim-mcp
```

The client must run **inside a Neovim terminal buffer**; that is where the
`$NVIM` socket it inherits comes from. Tools appear at the next session start,
since MCP servers connect at startup. If the tools never appear, the usual
cause is that `$NVIM` did not reach the server's environment: the server
registers nothing without it, and some clients strip the environment they
pass to servers.

<details>
<summary>Claude Code</summary>

```
claude mcp add overseer -- npx -y overseer-nvim-mcp
```

</details>

<details>
<summary>Codex CLI</summary>

```
codex mcp add overseer -- npx -y overseer-nvim-mcp
```

Then add one line to the generated block in `~/.codex/config.toml`:

```toml
[mcp_servers.overseer]
command = "npx"
args = ["-y", "overseer-nvim-mcp"]
env_vars = ["NVIM"]
```

The `env_vars` line is required. Codex passes stdio servers a fixed whitelist
of variables (`HOME`, `PATH`, `TERM` and the like), `$NVIM` is not on it, and
without it the server registers no tools.

Codex also won't reach for the server on its own; see
[Getting your agent to actually use it](#getting-your-agent-to-actually-use-it).

</details>

<details>
<summary>Antigravity CLI</summary>

In `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "overseer": {
      "command": "npx",
      "args": ["-y", "overseer-nvim-mcp"]
    }
  }
}
```

That user-global file is the one to use: the CLI's non-interactive print mode
(`agy -p`) loads MCP servers from it and from nowhere else; a workspace-level
`.agents/mcp_config.json` is silently ignored there.

Antigravity also won't reach for the server on its own; see
[Getting your agent to actually use it](#getting-your-agent-to-actually-use-it).

</details>

<details>
<summary>Gemini CLI</summary>

```
gemini mcp add overseer npx -y overseer-nvim-mcp
```

Or in `settings.json`:

```json
{
  "mcpServers": {
    "overseer": {
      "command": "npx",
      "args": ["-y", "overseer-nvim-mcp"]
    }
  }
}
```

</details>

<details>
<summary>opencode</summary>

In `opencode.json`:

```json
{
  "mcp": {
    "overseer": {
      "type": "local",
      "command": ["npx", "-y", "overseer-nvim-mcp"]
    }
  }
}
```

</details>

<details>
<summary>mcphub.nvim (codecompanion.nvim, avante.nvim)</summary>

In mcphub's servers config:

```json
{
  "mcpServers": {
    "overseer": {
      "command": "npx",
      "args": ["-y", "overseer-nvim-mcp"],
      "env": { "NVIM": "${NVIM}" }
    }
  }
}
```

The `env` block is required: mcp-hub does not pass its own environment to the
servers it spawns, so without it the server sees no `$NVIM` and registers no
tools. The server operates on the Neovim instance that started the hub. A hub
started outside Neovim has no `$NVIM` to forward, and mcp-hub reports this
server as disconnected with `Variable 'NVIM' not found`.

</details>

### Using with LazyVim

LazyVim ships an [overseer.nvim extra](https://www.lazyvim.org/extras/editor/overseer).
Enable it with `:LazyExtras` (select `editor.overseer`), restart Neovim, then
add the server to your MCP client as above. Nothing else is needed; the server
talks to whatever overseer configuration you already have.

## Tools

| Tool | Purpose |
|------|---------|
| `overseer_list_tasks` | Tasks with id, name, status, `exit_code`, `cmd`, `cwd`, timings, `origin` |
| `overseer_list_templates` | Templates in a directory (npm, go-task, make, just, VS Code) with `provider`, `desc`, `params` |
| `overseer_tail` | A task's output, with status; can block until a pattern appears |
| `overseer_run` | Start a long-running command: a raw `cmd` array, or a `template` with `params` |
| `overseer_restart` | Restart a task by id or name substring |
| `overseer_stop` | Stop a running task |
| `overseer_dispose` | Stop and remove a task from the list |

The last three take `force`, and refuse a running task you started without it.

Tasks are addressed by numeric id or a case-insensitive name substring, so an
agent can say `"dev"` instead of tracking ids.

## How it works

The transport is `$NVIM`, the RPC socket Neovim exports to every process it
spawns in a terminal buffer. Your MCP client inherits it, and this server, as a
child of that client, inherits it in turn.

Everything else follows from that:

- With **`$NVIM` set**, the server registers seven tools, each one
  `nvim_exec_lua` against overseer over msgpack-RPC.
- With **`$NVIM` unset**, it registers nothing and gets out of the way. Running
  outside Neovim is a no-op rather than an error.

There is no socket discovery: no cwd hashing, no `lsof`, no
`pgrep`. Those approaches are structurally broken (a cwd-hash scheme cannot tell
a crashed instance's stale socket from a live one and will unlink working
sockets; `pgrep` on macOS excludes the caller's own ancestors, which is exactly
the Neovim instance that matters). `$NVIM` sidesteps both by construction.

All user input (task names, commands, working directories) is passed as msgpack
arguments and arrives in Lua as `...`. Nothing is ever interpolated into Lua
source, so a task name cannot become code execution.

## It shares your task list, so it stays out of your tasks

The task list has two writers now, and only one of them can see it. Two things
keep that from biting:

- **A substring matching more than one task is an error** that lists the
  candidates and asks for a numeric id. `"dev"` matches a dozen names in a
  monorepo, and silently taking the first is how the wrong thing gets stopped.
- **Tasks are tagged with who started them.** `overseer_list_tasks` reports `origin`
  as `agent` or `user`, and `overseer_stop`, `overseer_restart` and
  `overseer_dispose` refuse a **running** task you started yourself unless
  `force` is passed. Finished tasks are unguarded, since removing a dead row
  costs nothing.

The asymmetry is on purpose. A wrong refusal costs one extra call. A wrong stop
kills your dev server, loses whatever state it held, and you would have no
reason to connect it to the agent.

`overseer_run` is for commands that **do not exit on their own**: dev servers,
file watchers, `--watch` test runs. Short commands that terminate by themselves
should stay on the agent's normal shell tool, where output is available in-band.
Round-tripping a two-second build through start-then-poll is worse.

## An empty template list is normal

`overseer_list_templates` returns whatever overseer's providers discover, verbatim.
Most repos declare nothing runnable and return an empty list. That is a
legitimate answer, not an error. This is why `overseer_run` takes a raw `cmd` as
its primary path: a template-only design would be unusable in the common case.

No provider-specific knowledge lives in this server. It does not filter or
rewrite results, including help-only entries some task runners expose, because
doing so would mean encoding one provider's conventions into a server that must
behave identically in a repo that has never heard of it.

What each entry carries:

```json
{
  "name": "just fixture-just-generate",
  "provider": "just",
  "desc": "Generate output for a language",
  "params": [{ "name": "lang", "type": "string", "required": true }],
  "running_task_id": 128
}
```

- **`desc` is an explicit `null`** when a provider supplies no descriptions.
  npm and make never do; go-task and just usually do. An explicit null says
  there is nothing to read, rather than leaving you guessing whether a field got
  dropped somewhere.
- **Entries with a description sort first.** That encodes nothing about any
  provider, only about information content. A repo with a Taskfile *and* a
  package.json would otherwise bury its documented half beneath dozens of bare
  npm script names.
- **`params` are the arguments a template takes**; `required` marks the ones
  `overseer_run` will refuse the call without. Pass them as `params`. A missing
  one is an error naming what it wanted rather than a prompt opened in your
  editor.
- **`running_task_id`** appears when a task of that name is already running.
  It is a name match, so it can miss (a template invoked with params produces a
  task named after the resolved command), but when it is there, it is the signal
  not to start a second dev server on top of yours.
- **`filter`** matches a substring against name and desc. Worth using: a
  three-runner monorepo can return well over eighty entries.

## Getting your agent to actually use it

On some clients this is automatic. The server returns MCP `instructions` in its
initialize result, and clients that surface those put them in the agent's system
prompt, where it is actually looking rather than buried among fifty tool
descriptions. It states the lifetime boundary (long-running here, short commands
on the shell) and tells the agent to check templates before reconstructing a
command, use `wait_for` instead of polling, and clean up only its own tasks.

The server withholds those instructions when `$NVIM` is unset, for the same
reason it registers no tools: a session that gets none should not be told how to
use them.

Whether the instructions reach the model is the whole game, and clients differ:

- **Claude Code** injects them. **Copilot CLI** injects them for servers whose
  instructions you allow (`--allow-all-mcp-server-instructions` in scripted
  runs).
- **Codex CLI** shows the model the tool definitions but not the instructions,
  and leaving servers untouched until prompted is a known
  [open issue](https://github.com/openai/codex/issues/29146). Asked to "start
  the dev server", it runs `npm run dev` in its own shell with the server
  connected and working.
- **Antigravity CLI** injects nothing at all: it writes the instructions and
  every tool schema to files under `~/.gemini/antigravity-cli/mcp/overseer/`
  that the model only reads once something points it there. Same prompt, same
  result: its own shell.

On those two, either name overseer in the prompt ("start the dev server in
overseer" works on both) or say it once in the place the client actually
reads: its context file. One line in `AGENTS.md` (Codex) or `GEMINI.md` (Antigravity)
flips the same prompt to full overseer routing: templates checked first, task
run by name, output tailed after.

The markdown below is that one-time instruction, and it belongs in your
project context file on every client (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, whatever yours reads).
Clients re-read project instructions constantly, so they outweigh anything the
server can send:

```markdown
## Long-running commands

Start dev servers, file watchers and `--watch` test runs with `overseer_run`,
not the shell. They then appear in my task list, I can stop them myself, and
their process trees get torn down properly instead of being orphaned.

Short commands that exit on their own stay on the shell: their output is
in-band there, which is what you want.

Check `overseer_list_templates` first. If the repo declares one that matches, run
it by name rather than reconstructing the command.
```

If that still isn't enough, a `PreToolUse` hook makes it deterministic. This one
blocks the shell for a few unambiguous cases and tells the agent what to do
instead. Start narrow and add patterns you actually hit, since a hook that fires
on the wrong thing is worse than none:

```bash
#!/usr/bin/env bash
# ~/.claude/hooks/prefer-overseer.sh: exit 2 blocks the call and shows stderr
# to the agent. Receives the tool call as JSON on stdin.
cmd=$(jq -r '.tool_input.command // ""')
case "$cmd" in
  *"vitest run"*) ;; # one-shot, stays on the shell
  *" --watch"*|*"vitest"*|*"npm run dev"*|*"pnpm dev"*|*"yarn dev"*)
    echo "This looks long-running. Use overseer_run so it lands in the task list and can be stopped." >&2
    exit 2
    ;;
esac
exit 0
```

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "~/.claude/hooks/prefer-overseer.sh" }]
      }
    ]
  }
}
```

### Waiting, without spinning

An agent driving a task by hand ends up guessing: start it, tail, get nothing,
tail again, get nothing. It has no way to sleep, so every guess is a round-trip
you watch scroll past.

`overseer_tail` takes a `wait_for` regex instead. It returns the moment a
matching line appears, or when the task exits, or at `timeout_ms`, and says
which of the three happened, so a timeout can't be misread as success:

```
overseer_tail { task: 48, wait_for: "ready - listening" }

status=RUNNING total=5 from=1 waited=matched
compiling... 0
compiling... 1
compiling... 2
ready - listening on http://localhost:3000
GET /route-4 200
```

`total` is a cursor. Pass it back as `since` and you get only what is new,
rather than re-reading the same screenful every poll:

```
overseer_tail { task: 48, since: 5 }

status=RUNNING total=9 from=6
GET /route-5 200
GET /route-6 200
GET /route-7 200
GET /route-8 200
```

`from` is the index the block actually starts at. If it is greater than
`since + 1`, output scrolled past between calls and you are looking at a gap
rather than a continuation.

`overseer_run` waits briefly too, up to `settle_ms` (default 1500, `0` to
disable), returning as soon as the task produces output or exits. A command that
dies on startup reports its failure there instead of returning the same bare id
a healthy dev server would.

**The waiting happens in Node.** This server runs inside
your editor, and `vim.wait` does not process input, so a fifteen-second wait in
Lua would freeze your session for fifteen seconds. Polling over the local socket
keeps Neovim responsive, and you never see the round-trips.

## Slash commands and attachable resources

Tools are what the agent calls. The server also publishes two things *you* drive.

**Prompts** appear as slash commands (`/mcp__overseer__...` in Claude Code). The
server generates them per invocation, so they inspect your live editor state
rather than reciting a generic answer:

- **`directory_local_task`** defines a task for a project that has no npm
  script, Makefile or Taskfile, using overseer's own `register_template` in a
  `.nvim.lua`. It checks whether `exrc` is actually on and whether a `.nvim.lua`
  already exists, and includes the two things that make a correct setup look
  broken: it will not appear until Neovim restarts, and Neovim will ask you to
  `:trust` the file.
- **`diagnose`** explains why overseer is not showing the tasks you expect.
  Overseer records, per provider, why it contributed nothing, and that reason is
  otherwise invisible:

  ```
  - `npm`: 11/11 available
  - `make`: 0/0 available - No Makefile found
  - `mise`: 0/0 available - Command "mise" not found
  ```

  Which distinguishes "nothing to read here" from "that runner isn't installed",
  a distinction an empty list cannot make.

**Resources** are attachable rather than called:

- `overseer://tasks`: the whole task list as JSON
- `overseer://task/{id}/output`: one task's output, with a status line

The server enumerates the per-task URIs with live ids and supports completion,
so a client can offer the tasks that exist instead of making you look one up.

## Notes

- Output from a task started over RPC lives in the strategy's pending buffer, not
  a terminal buffer, until you open the overseer panel. `overseer_tail` reads
  both, strips ANSI colour codes and carriage returns, and trims the PTY's blank
  padding so you get clean log lines rather than the bottom of an empty grid.
- `exit_code` is absent while a task is running and present once it exits, which
  is how an agent distinguishes a clean finish from a crash.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Releases are automated with
release-please, so commits must follow
[Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT © Miguel Angelo Sepulveda
